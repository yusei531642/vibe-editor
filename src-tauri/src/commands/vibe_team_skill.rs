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
