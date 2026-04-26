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
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Skill ファイル本文の現行バージョン。SKILL.md 先頭に埋め込んでおき、
/// Rust 側がファイルを見たときに「ユーザーが手で編集したか / 古いバンドル版か」を判別できるようにする。
const SKILL_VERSION: &str = "1.3.0";

/// vibe-team Skill 本文。Claude Code の Skill 形式 (frontmatter + Markdown body) で書く。
///
/// 内容の方針:
///   - Leader / HR / 動的ワーカーの 3 役それぞれの責務を 1 セクションずつ。
///   - team_recruit ツールの引数と「設計＋採用 1 コール」フローを具体例つきで示す。
///   - 全エージェント共通の「絶対ルール」を最後にまとめる (Issue #112 対策の待機ルール、
///     報告フロー、ポーリング禁止)。
///   - エンジン (claude / codex) の選択指針も記述。
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

/// `<project_root>/.claude/skills/vibe-team/SKILL.md` を書き出す。
///
/// - `force_overwrite=false` の場合、既存ファイルの先頭に同 SKILL_VERSION のヘッダがあれば no-op。
///   ユーザーが編集していたら尊重する (再上書きしない)。
/// - `force_overwrite=true` の場合、無条件で上書き (ヘッダもバージョン行も最新版に揃う)。
fn skill_dir(project_root: &Path) -> PathBuf {
    project_root.join(".claude").join("skills").join("vibe-team")
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

#[tauri::command]
pub async fn app_install_vibe_team_skill(
    project_root: String,
    force_overwrite: Option<bool>,
) -> InstallSkillResult {
    let force = force_overwrite.unwrap_or(false);
    let trimmed = project_root.trim();
    if trimmed.is_empty() {
        return InstallSkillResult {
            ok: false,
            error: Some("project_root is empty".into()),
            ..Default::default()
        };
    }
    let root = PathBuf::from(trimmed);
    if !root.is_dir() {
        return InstallSkillResult {
            ok: false,
            error: Some(format!("project_root is not a directory: {trimmed}")),
            ..Default::default()
        };
    }
    let dir = skill_dir(&root);
    let path = skill_path(&root);

    // 既存ファイルが「同じバージョン」のヘッダで始まっていれば、ユーザーが触っていない
    // バンドル版のはずなので、念のため最新内容で同期する (本文の更新を反映させる)。
    // ヘッダが無い or バージョンが違う = ユーザーが編集している可能性 → force=false なら触らない。
    let new_text = current_skill_text();
    let header_prefix = header_line();
    let mut overwritten = false;
    let mut skipped = false;

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
            skipped = true;
            return InstallSkillResult {
                ok: true,
                path: Some(path.to_string_lossy().into_owned()),
                skipped,
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
    tracing::info!(
        "[skill] vibe-team SKILL.md installed at {} (overwrite={overwritten})",
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

/// 内部呼び出し版 (setup_team_mcp など他コマンドから使う)。force=false。
/// エラーは握りつぶして best-effort で動作する。
pub async fn install_skill_best_effort(project_root: &str) {
    let result = app_install_vibe_team_skill(project_root.to_string(), Some(false)).await;
    if !result.ok {
        if let Some(e) = result.error {
            tracing::warn!("[skill] install failed (best-effort): {e}");
        }
    }
}
