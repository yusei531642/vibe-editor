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
use crate::team_hub::TeamHub;

/// 監査ログに raw path を出すときの clamp (制御文字を `?` に置換 + 240 文字で truncate)。
/// renderer 由来の project_root に改行や ESC が混じっていても tracing 行を破壊しないようにする。
fn clamp_for_log(raw: &str) -> String {
    raw.chars()
        .take(240)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// 監査ログ用に team_id を clamp する (制御文字 `?` 置換 + 96 文字 truncate)。
/// `team_id` 自体は ASCII 系の short string が想定だが、renderer から来る入力は信用しない。
fn clamp_team_id_for_log(raw: &str) -> String {
    raw.chars()
        .take(96)
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

/// Issue #601 (Tier A-3): renderer 由来の `team_id` が `TeamHub` の active set に含まれるかを
/// 検証する。`team_diagnostics_read` (#601) のような **renderer がリーダー視点を impersonate
/// する** IPC で、過去 / 別プロジェクト / 任意 fabricated な team_id を probe されないように
/// recon を抑止するための helper。
///
/// 設計判断:
/// - 「空 team_id」「未登録 team_id」「正常な team_id」のうち最初の 2 つは同じ
///   `Authz("team is not active or does not exist")` で reject する。これは存在 / 非存在を
///   区別しない recon 抑止の方針 (issue #601 案1)。
/// - reject 時は `tracing::warn!` で clamp 済み team_id を audit log に残す。
/// - 返却型は `()` (active 確認だけが目的、戻り値で team の詳細を返さない)。
pub async fn assert_active_team(hub: &TeamHub, team_id: &str) -> CommandResult<()> {
    let trimmed = team_id.trim();
    if trimmed.is_empty() {
        tracing::warn!(
            team_id = %clamp_team_id_for_log(team_id),
            "[authz] assert_active_team rejected: empty team_id"
        );
        return Err(CommandError::authz(
            "team is not active or does not exist",
        ));
    }

    let state = hub.state.lock().await;
    if !state.active_teams.contains(trimmed) {
        // `members` の中に過去の (= dismiss 済み) team_id が残っていても probe させない。
        let active_count = state.active_teams.len();
        drop(state);
        tracing::warn!(
            team_id = %clamp_team_id_for_log(team_id),
            active_count,
            "[authz] assert_active_team rejected: team_id not in active set"
        );
        return Err(CommandError::authz(
            "team is not active or does not exist",
        ));
    }
    Ok(())
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

    // ===== Issue #601 (Tier A-3): assert_active_team helper =====

    mod active_team {
        use super::*;
        use crate::pty::SessionRegistry;
        use crate::team_hub::TeamHub;
        use std::sync::Arc;

        async fn insert_active_team(hub: &TeamHub, team_id: &str) {
            let mut s = hub.state.lock().await;
            s.active_teams.insert(team_id.to_string());
        }

        /// active set に登録された team_id は accept される。
        #[tokio::test]
        async fn accepts_team_id_in_active_set() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-active-001").await;
            assert_active_team(&hub, "team-active-001")
                .await
                .expect("active team_id should be accepted");
        }

        /// active set に居ない team_id は recon 抑止の generic message で reject される。
        #[tokio::test]
        async fn rejects_team_id_not_in_active_set() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-active-002").await;
            // 別の team_id (= 過去に dismiss した / 別 project の team / fabricated) を渡す
            let err = assert_active_team(&hub, "team-of-projectA-fabricated")
                .await
                .unwrap_err();
            assert!(
                matches!(err, CommandError::Authz(ref m) if m == "team is not active or does not exist"),
                "got: {err}"
            );
        }

        /// 存在しない / 空の team_id は同じ generic message で reject される
        /// (= recon 抑止: 存在 / 非存在を区別しない)。
        #[tokio::test]
        async fn rejects_empty_team_id_with_same_message_as_unknown() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-active-003").await;

            let err_empty = assert_active_team(&hub, "").await.unwrap_err();
            let err_whitespace = assert_active_team(&hub, "   ").await.unwrap_err();
            let err_unknown = assert_active_team(&hub, "team-unknown-xyz").await.unwrap_err();

            // 全部同じ generic message にすることで「team_id がそもそも空」と
            // 「team_id が active set に居ない」を caller から区別できなくする。
            for err in [&err_empty, &err_whitespace, &err_unknown] {
                assert!(
                    matches!(err, CommandError::Authz(ref m) if m == "team is not active or does not exist"),
                    "got: {err}"
                );
            }
        }

        /// dismiss された team_id は accept されない
        /// (= state.active_teams.remove で集合から外れているはず)。
        #[tokio::test]
        async fn rejects_team_id_after_remove() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-tmp").await;
            // 一度 accept される
            assert_active_team(&hub, "team-tmp")
                .await
                .expect("should accept while in active set");
            // 集合から外す (dismiss 相当)
            {
                let mut s = hub.state.lock().await;
                s.active_teams.remove("team-tmp");
            }
            // 以降は generic reject に変わる
            let err = assert_active_team(&hub, "team-tmp").await.unwrap_err();
            assert!(
                matches!(err, CommandError::Authz(ref m) if m == "team is not active or does not exist"),
                "got: {err}"
            );
        }

        /// `team_id` を trim したうえで active set と比較する
        /// (= `"  team-x  "` のような padding は無害化して accept させる)。
        #[tokio::test]
        async fn accepts_team_id_after_trim() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-trimmed").await;
            assert_active_team(&hub, "  team-trimmed  ")
                .await
                .expect("trim 済み team_id should be accepted");
        }
    }
}
