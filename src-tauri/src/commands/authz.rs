//! Issue #600 (Tier A-2): cross-project leak を防ぐための authorization helper。
//!
//! 背景: `team_state_read` (#600) / `team_diagnostics_read` (#601 / A-3) /
//! `handoffs_*` (#609 / A-8) など複数 IPC が renderer 由来の `project_root` を
//! 引数で受け取り、その path を base64 encode して `~/.vibe-editor/team-state/...`
//! 配下のファイルを読みに行く。`AppState` の active project_root と一致するか
//! 検証していないため、同じ user の別プロジェクトの team-state を任意に閲覧できる
//! cross-project leak が成立していた。
//!
//! 本 module は `app_install_vibe_team_skill` (#191 で実装済み) と同じ手順
//! (`lock_project_root_recover` → `canonicalize` 両者比較) を `assert_active_project_root`
//! 1 関数に共通化し、A-2 / A-3 / A-8 で同じ防御を横展開できるようにする。

use std::path::PathBuf;
use std::sync::Mutex;

use crate::commands::error::{CommandError, CommandResult};
use crate::state::lock_project_root_recover;

/// 監査ログに raw path を出すときの clamp (制御文字を `?` に置換 + 240 文字で truncate)。
/// renderer 由来の project_root に改行や ESC が混じっていても tracing 行を破壊しないようにする。
fn clamp_for_log(raw: &str) -> String {
    raw.chars()
        .take(240)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// renderer 由来の `given` project_root が `AppState` の active project_root と
/// canonicalize 比較で一致するかを検証する。
///
/// - `given` が空 → `Authz("project_root is empty")`
/// - active が `None` / 空 → `Authz("no active project_root configured")`
///   (起動直後で project が選ばれていないケース)
/// - canonicalize に失敗した側 (= 存在しない / シンボリックリンク辿れず 等) →
///   `Authz` で reject (それぞれ `requested project_root` / `active project_root`
///   どちらが失敗したかを message に含める)
/// - 両者が一致しない → `Authz("project_root does not match active project")`
///
/// reject 時は `tracing::warn!` で active / 試行 path (clamp 済み) を audit log に残す。
/// 戻り値は **canonicalize 後の active path** (caller が後続処理で使えるよう返す)。
pub async fn assert_active_project_root(
    project_root_lock: &Mutex<Option<String>>,
    given: &str,
) -> CommandResult<PathBuf> {
    let trimmed = given.trim();
    if trimmed.is_empty() {
        tracing::warn!(
            given = %clamp_for_log(given),
            "[authz] assert_active_project_root rejected: empty project_root"
        );
        return Err(CommandError::authz("project_root is empty"));
    }

    let active = lock_project_root_recover(project_root_lock)
        .clone()
        .unwrap_or_default();
    if active.trim().is_empty() {
        tracing::warn!(
            given = %clamp_for_log(given),
            "[authz] assert_active_project_root rejected: no active project_root configured"
        );
        return Err(CommandError::authz("no active project_root configured"));
    }

    let req_canon = match std::fs::canonicalize(trimmed) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                given = %clamp_for_log(given),
                error = %e,
                "[authz] assert_active_project_root rejected: canonicalize requested project_root failed"
            );
            return Err(CommandError::authz(format!(
                "canonicalize requested project_root failed: {e}"
            )));
        }
    };
    let active_canon = match std::fs::canonicalize(active.trim()) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                active = %clamp_for_log(&active),
                error = %e,
                "[authz] assert_active_project_root rejected: canonicalize active project_root failed"
            );
            return Err(CommandError::authz(format!(
                "canonicalize active project_root failed: {e}"
            )));
        }
    };

    if req_canon != active_canon {
        tracing::warn!(
            requested = %clamp_for_log(&req_canon.to_string_lossy()),
            active = %clamp_for_log(&active_canon.to_string_lossy()),
            "[authz] assert_active_project_root rejected: project_root mismatch"
        );
        return Err(CommandError::authz(
            "project_root does not match active project",
        ));
    }

    Ok(active_canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn make_lock(value: Option<String>) -> Mutex<Option<String>> {
        Mutex::new(value)
    }

    #[tokio::test]
    async fn rejects_empty_given() {
        let lock = make_lock(Some("/tmp/whatever".to_string()));
        let err = assert_active_project_root(&lock, "")
            .await
            .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("empty")),
            "got: {err}"
        );
        // 全角空白を含む whitespace のみも reject
        let err = assert_active_project_root(&lock, "   \t  ")
            .await
            .unwrap_err();
        assert!(matches!(err, CommandError::Authz(ref m) if m.contains("empty")));
    }

    #[tokio::test]
    async fn rejects_when_no_active_project_root() {
        let lock = make_lock(None);
        let dir = tempdir().expect("tempdir");
        let err = assert_active_project_root(&lock, dir.path().to_string_lossy().as_ref())
            .await
            .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("no active project_root")),
            "got: {err}"
        );

        // active が "" / whitespace のみのときも No active 判定。
        let lock = make_lock(Some("   ".to_string()));
        let err = assert_active_project_root(&lock, dir.path().to_string_lossy().as_ref())
            .await
            .unwrap_err();
        assert!(matches!(err, CommandError::Authz(ref m) if m.contains("no active project_root")));
    }

    #[tokio::test]
    async fn rejects_when_given_does_not_exist() {
        let active = tempdir().expect("active tempdir");
        let lock = make_lock(Some(active.path().to_string_lossy().into_owned()));

        // 存在しない path → canonicalize fail で reject
        let bogus = active.path().join("does-not-exist-xyz123");
        let err = assert_active_project_root(&lock, bogus.to_string_lossy().as_ref())
            .await
            .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("canonicalize requested project_root failed")),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_when_paths_differ() {
        let project_a = tempdir().expect("project A");
        let project_b = tempdir().expect("project B");
        // active は project_a
        let lock = make_lock(Some(project_a.path().to_string_lossy().into_owned()));

        // 攻撃: renderer から project_b を渡す → canonicalize 比較で reject
        let err =
            assert_active_project_root(&lock, project_b.path().to_string_lossy().as_ref())
                .await
                .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("does not match active project")),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn accepts_when_paths_match() {
        let project = tempdir().expect("project");
        let lock = make_lock(Some(project.path().to_string_lossy().into_owned()));

        // 同じ path を渡す → 一致して canonical path が返る
        let canon = assert_active_project_root(&lock, project.path().to_string_lossy().as_ref())
            .await
            .expect("matching paths should pass");
        assert_eq!(
            canon,
            std::fs::canonicalize(project.path()).expect("canonicalize"),
        );
    }

    #[tokio::test]
    async fn accepts_when_paths_differ_only_in_canonical_form() {
        // active path に末尾 separator や `./` を加えても canonicalize で同一になるなら通る。
        let project = tempdir().expect("project");
        let active_raw = project.path().to_string_lossy().into_owned();
        let lock = make_lock(Some(active_raw.clone()));

        // 末尾 separator を付けた variant を given にする
        let mut given = active_raw.clone();
        if !given.ends_with(std::path::MAIN_SEPARATOR) {
            given.push(std::path::MAIN_SEPARATOR);
        }
        let canon = assert_active_project_root(&lock, &given)
            .await
            .expect("trailing separator should canonicalize equal");
        assert_eq!(canon, std::fs::canonicalize(project.path()).expect("canon"));
    }
}
