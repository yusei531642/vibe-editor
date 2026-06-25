// vibe-team Skill 自動配置
//
// プロジェクトルート直下の `.claude/skills/vibe-team/SKILL.md` に、
// vibe-team の Leader / HR / 動的ワーカーが共通で参照する「行動ルールブック」を書き出す。
//
// 設計意図:
//   - 長大なシステムプロンプトを TS/Rust にハードコードすると可読性とメンテ性が落ちる。
//     Claude Code の Skill 機能 (https://docs.claude.com/.../skills) に乗せ、ファイル化することで:
//       - エージェントが必要なときだけ Skill を読み込む (毎回 prompt に詰めない)
//       - ユーザーがファイルを直接編集してチームの振る舞いを調整できる
//       - vibe-editor 以外の Claude Code 利用 (terminal 直接 / 他 CLI) でも同じルールを共有できる
//   - 名前空間の独立性: Skill 名は "vibe-team"。ファイルパスも `vibe-team/SKILL.md` に固定し、
//     裏で動く可能性のある他の agent teams 系ツールとは明確に分離する。
//
// 配置タイミング: setup_team_mcp で「実チーム」を初めて起動するときに 1 回書き出す。
// _init / 空 team_id ではスキップする。既存ファイルを上書きするかは forceOverwrite で制御。

use crate::commands::atomic_write::atomic_write;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::fs;

/// Skill ファイル本文の現行バージョン。SKILL.md 先頭に埋め込んでおき、
/// Rust 側がファイルを見たときに「ユーザーが手で編集したか / 古いバンドル版か」を判別できるようにする。
const SKILL_VERSION: &str = "1.6.3";

/// vibe-team Skill 本文。Claude Code の Skill 形式 (frontmatter + Markdown body) で書く。
const SKILL_BODY: &str = include_str!("./vibe_team_skill_body.md");

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillResult {
    pub ok: bool,
    /// 書き出した実パス (相対ではなく絶対)。スキップ時は None。
    pub path: Option<String>,
    /// 既に同じバージョンが存在し no-op だった場合 true。
    pub skipped: bool,
    /// 上書きした場合 true (forceOverwrite=true && 既存ファイルあり)。
    pub overwritten: bool,
    pub error: Option<String>,
}

fn skill_dir(project_root: &Path) -> PathBuf {
    project_root
        .join(".claude")
        .join("skills")
        .join("vibe-team")
}

fn skill_path(project_root: &Path) -> PathBuf {
    skill_dir(project_root).join("SKILL.md")
}

fn header_line() -> String {
    format!("<!-- vibe-team-skill-version: {SKILL_VERSION} -->\n")
}

fn current_skill_text() -> String {
    let mut out = String::with_capacity(SKILL_BODY.len() + 64);
    out.push_str(&header_line());
    out.push_str(SKILL_BODY);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Issue #998: API エージェントが TeamHub 参加時に自動追加する `vibe-team` skill の
/// バンドル本文。プロジェクトに `.claude/skills/vibe-team/SKILL.md` がまだ書き出されて
/// いない (= チーム未起動) 場合のフォールバックとして使う。
pub(crate) fn bundled_vibe_team_skill_text() -> String {
    current_skill_text()
}

/// SKILL.md 先頭の `<!-- vibe-team-skill-version: X.Y.Z -->` 行から
/// (major, minor, patch) を抽出する。ヘッダが無い / 数値 3 連でない場合は None。
///
/// Issue #1108: バンドル版より新しい on-disk 版を縮退上書きしないための版比較に使う。
fn parse_skill_version(text: &str) -> Option<(u64, u64, u64)> {
    // ヘッダは先頭行にある想定だが、空行等を許容して先頭数行だけ走査する。
    for line in text.lines().take(8) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("<!-- vibe-team-skill-version:") {
            let ver = rest.trim_end_matches("-->").trim();
            return parse_semver(ver);
        }
    }
    None
}

/// `X.Y.Z` 形式の文字列を (major, minor, patch) に parse する。
/// 3 連の数値でない (要素数違い / 非数値) 場合は None を返し、呼び出し側は保守的に扱う。
fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next()?.trim().parse().ok()?;
    let patch = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        // 4 要素以上は想定外の書式 → 不正とみなす。
        return None;
    }
    Some((major, minor, patch))
}

/// 実際の書き出し処理。境界チェックを通過した後の root を渡すこと。
/// renderer から直接呼ばせない (state を経由した command 経由でのみ呼ばれる)。
async fn install_skill_at(root: &Path, force: bool) -> InstallSkillResult {
    if !root.is_dir() {
        return InstallSkillResult {
            ok: false,
            error: Some(format!(
                "project_root is not a directory: {}",
                root.display()
            )),
            ..Default::default()
        };
    }
    let dir = skill_dir(root);
    let path = skill_path(root);

    let new_text = current_skill_text();
    let header_prefix = header_line();
    let mut overwritten = false;

    if let Ok(existing) = fs::read_to_string(&path).await {
        let starts_with_current_header = existing.starts_with(&header_prefix);
        if starts_with_current_header && existing == new_text {
            // 内容まで完全一致 → no-op
            return InstallSkillResult {
                ok: true,
                path: Some(path.to_string_lossy().into_owned()),
                skipped: true,
                ..Default::default()
            };
        }
        // Issue #1108: on-disk が bundled より「新しい」版なら、force=true でも縮退上書き
        // しない。on-disk ヘッダの版を parse して bundled SKILL_VERSION と semver 比較し、
        // disk が厳密に新しい場合だけ skip する。版が無い / 同等以下の場合は guard を
        // 素通りさせ、従来挙動 (下の force / ユーザー編集判定) を保守的に維持する。
        if let (Some(disk_ver), Some(bundled_ver)) =
            (parse_skill_version(&existing), parse_semver(SKILL_VERSION))
        {
            if disk_ver > bundled_ver {
                tracing::info!(
                    "[skill] on-disk vibe-team SKILL.md is newer ({}.{}.{}) than bundled ({}.{}.{}); skip to avoid downgrade (force={force})",
                    disk_ver.0,
                    disk_ver.1,
                    disk_ver.2,
                    bundled_ver.0,
                    bundled_ver.1,
                    bundled_ver.2,
                );
                return InstallSkillResult {
                    ok: true,
                    path: Some(path.to_string_lossy().into_owned()),
                    skipped: true,
                    ..Default::default()
                };
            }
        }
        if !force && !starts_with_current_header {
            // ユーザー編集を上書きしない
            return InstallSkillResult {
                ok: true,
                path: Some(path.to_string_lossy().into_owned()),
                skipped: true,
                ..Default::default()
            };
        }
        overwritten = true;
    }

    if let Err(e) = fs::create_dir_all(&dir).await {
        return InstallSkillResult {
            ok: false,
            error: Some(format!("create_dir_all failed: {e}")),
            ..Default::default()
        };
    }
    if let Err(e) = atomic_write(&path, new_text.as_bytes()).await {
        return InstallSkillResult {
            ok: false,
            error: Some(format!("atomic_write failed: {e:#}")),
            ..Default::default()
        };
    }
    // Issue #140: 絶対パスを INFO ログに残すと bug report で home / user 名が漏れる。
    // INFO はマスク済み path、DEBUG にだけ生 path を残す。
    tracing::info!(
        "[skill] vibe-team SKILL.md installed at {} (overwrite={overwritten})",
        crate::util::log_redact::redact_home(&path.to_string_lossy())
    );
    tracing::debug!(
        "[skill] vibe-team SKILL.md installed at (raw) {}",
        path.display()
    );
    InstallSkillResult {
        ok: true,
        path: Some(path.to_string_lossy().into_owned()),
        overwritten,
        skipped: false,
        error: None,
    }
}

#[tauri::command]
pub async fn app_install_vibe_team_skill(
    state: State<'_, AppState>,
    project_root: String,
    force_overwrite: Option<bool>,
) -> crate::commands::error::CommandResult<InstallSkillResult> {
    let force = force_overwrite.unwrap_or(false);
    let trimmed = project_root.trim();
    if trimmed.is_empty() {
        return Ok(InstallSkillResult {
            ok: false,
            error: Some("project_root is empty".into()),
            ..Default::default()
        });
    }
    // Issue #135 (Security): renderer から来る project_root が AppState の現在値と一致
    // するか canonicalize 比較する。一致しないとユーザー HOME 等の任意ディレクトリ配下に
    // .claude/skills/vibe-team/SKILL.md を作成できてしまい AI hijack 経路になる。
    // Issue #739: ArcSwapOption の lock-free load で現在値を読む。
    let active = crate::state::current_project_root(&state.project_root).unwrap_or_default();
    if active.trim().is_empty() {
        return Ok(InstallSkillResult {
            ok: false,
            error: Some("no active project_root configured".into()),
            ..Default::default()
        });
    }
    let req_canon = match std::fs::canonicalize(trimmed) {
        Ok(p) => p,
        Err(e) => {
            return Ok(InstallSkillResult {
                ok: false,
                error: Some(format!("canonicalize requested project_root failed: {e}")),
                ..Default::default()
            });
        }
    };
    let active_canon = match std::fs::canonicalize(active.trim()) {
        Ok(p) => p,
        Err(e) => {
            return Ok(InstallSkillResult {
                ok: false,
                error: Some(format!("canonicalize active project_root failed: {e}")),
                ..Default::default()
            });
        }
    };
    if req_canon != active_canon {
        return Ok(InstallSkillResult {
            ok: false,
            error: Some("project_root does not match active project".into()),
            ..Default::default()
        });
    }
    Ok(install_skill_at(&req_canon, force).await)
}

/// 内部呼び出し版 (setup_team_mcp など他コマンドから使う)。force=false。
/// state チェックは呼び出し側で済んでいる前提。エラーは握りつぶして best-effort で動作する。
pub async fn install_skill_best_effort(project_root: &str) {
    let trimmed = project_root.trim();
    if trimmed.is_empty() {
        return;
    }
    let root = match std::fs::canonicalize(trimmed) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[skill] canonicalize failed (best-effort): {e}");
            return;
        }
    };
    let result = install_skill_at(&root, false).await;
    if !result.ok {
        if let Some(e) = result.error {
            tracing::warn!("[skill] install failed (best-effort): {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 指定の本文を temp dir 配下の `.claude/skills/vibe-team/SKILL.md` に書き出す。
    async fn write_skill(root: &Path, body: &str) {
        let dir = skill_dir(root);
        fs::create_dir_all(&dir).await.unwrap();
        atomic_write(&skill_path(root), body.as_bytes())
            .await
            .unwrap();
    }

    /// `<!-- vibe-team-skill-version: VER -->` ヘッダ付きの本文を組み立てる。
    fn versioned(ver: &str, extra_body: &str) -> String {
        format!("<!-- vibe-team-skill-version: {ver} -->\n{extra_body}\n")
    }

    #[test]
    fn parse_skill_version_reads_header() {
        assert_eq!(
            parse_skill_version("<!-- vibe-team-skill-version: 1.6.4 -->\nbody"),
            Some((1, 6, 4))
        );
        // ヘッダ無しは None。
        assert_eq!(parse_skill_version("just a user note\nbody"), None);
        // 非数値 / 桁数違いは None (保守的に従来挙動へ)。
        assert_eq!(
            parse_skill_version("<!-- vibe-team-skill-version: 1.x.0 -->"),
            None
        );
        assert_eq!(
            parse_skill_version("<!-- vibe-team-skill-version: 1.6 -->"),
            None
        );
    }

    /// (1) on-disk が bundled より新しい場合、force=true でも縮退上書きせず skip する。
    #[tokio::test]
    async fn newer_on_disk_is_not_downgraded_even_with_force() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // bundled SKILL_VERSION より確実に新しい版を on-disk に置く。
        let newer = versioned("99.0.0", "DISK NEWER BODY — must be preserved");
        write_skill(root, &newer).await;

        let result = install_skill_at(root, true).await;

        assert!(result.ok, "install should report ok");
        assert!(result.skipped, "newer on-disk must be skipped");
        assert!(
            !result.overwritten,
            "newer on-disk must NOT be overwritten (downgrade guard)"
        );
        let after = fs::read_to_string(skill_path(root)).await.unwrap();
        assert_eq!(after, newer, "on-disk content must be left untouched");
    }

    /// (2) on-disk が同等以下の版なら force で bundled 本文が配置される (従来挙動)。
    #[tokio::test]
    async fn older_on_disk_is_replaced_with_force() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let older = versioned("0.0.1", "OLD DISK BODY");
        write_skill(root, &older).await;

        let result = install_skill_at(root, true).await;

        assert!(result.ok, "install should report ok");
        assert!(result.overwritten, "older on-disk must be overwritten");
        assert!(!result.skipped, "older on-disk must not be skipped");
        let after = fs::read_to_string(skill_path(root)).await.unwrap();
        assert_eq!(after, current_skill_text(), "bundled text must be written");
    }

    /// (3) ヘッダ無し + force=false なら従来通りユーザー編集として保護 (skip) する。
    #[tokio::test]
    async fn headerless_on_disk_is_protected_without_force() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let user_edited = "ユーザーが手で書いた SKILL.md\nバージョンヘッダ無し\n";
        write_skill(root, user_edited).await;

        let result = install_skill_at(root, false).await;

        assert!(result.ok, "install should report ok");
        assert!(result.skipped, "headerless user edit must be skipped");
        assert!(
            !result.overwritten,
            "headerless user edit must not be overwritten"
        );
        let after = fs::read_to_string(skill_path(root)).await.unwrap();
        assert_eq!(after, user_edited, "user-edited content must be preserved");
    }
}
