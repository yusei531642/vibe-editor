// api_agents/skills — vibe-editor 専用 skill フォルダの列挙/読み込みと、Claude/Codex skill の
// import (Issue #998 / #1017)。
//
// 構成:
//   - API エージェントが読む skill ソースは vibe-editor 専用フォルダ `~/.vibe-editor/skills`。
//   - import 元は Claude (`~/.claude/skills`, `<project>/.claude/skills`) と
//     Codex (`~/.agents/skills`, `<project>/.agents/skills`)。設定からコピー (snapshot) する。
//
// セキュリティ方針:
//   - skill id は `is_valid_id_segment` で検証し、`..` / `/` を含む traversal を拒否。
//   - 各 skills root を canonicalize し、SKILL.md の実体が root 配下に収まることを検証して
//     symlink escape を拒否 (canonicalize 後の実体パスを read するため TOCTOU も回避)。
//   - SKILL.md 読み込みはサイズ上限でキャップ (巨大ファイルでの OOM 回避)。

use crate::commands::atomic_write::atomic_write;
use crate::commands::error::{CommandError, CommandResult};
use crate::commands::validation::is_valid_id_segment;
use crate::state::{current_project_root, AppState};
use crate::util::config_paths;
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::fs;

use super::types::{
    ApiAgentSkill, ApiAgentSkillMeta, ImportSkillRequest, ImportableSkill, SkillApplyResult,
    SkillApplyStatus,
};

/// 1 つの SKILL.md から読み込む最大バイト数。
const MAX_SKILL_FILE_BYTES: usize = 256 * 1024;

/// TeamHub 参加時に自動追加する skill。
pub(super) const VIBE_TEAM_SKILL_ID: &str = "vibe-team";

// ============================================================
// 専用フォルダ (API エージェントが読む skill ソース)
// ============================================================

/// vibe-editor 専用 skill フォルダ (`~/.vibe-editor/skills`) の skill 一覧を返す。
#[tauri::command]
pub async fn api_agent_skill_list() -> CommandResult<Vec<ApiAgentSkillMeta>> {
    Ok(list_skills_in(&config_paths::vibe_skills_dir()).await)
}

/// `api_agent_send` から呼ぶ内部ヘルパ。選択された `skill_ids` + 自動 `vibe-team` の本文を、
/// 専用フォルダから読み込んで返す。無効 id / 不在ファイルはスキップ。`vibe-team` だけは
/// ファイルが無ければバンドル本文へフォールバックする。
pub(super) async fn load_skill_bodies(skill_ids: &[String]) -> Vec<ApiAgentSkill> {
    load_skill_bodies_from(&config_paths::vibe_skills_dir(), skill_ids).await
}

// ============================================================
// import 元 (Claude / Codex) の列挙と import / remove
// ============================================================

/// import 候補の skills root を (source, scope, path) で返す (Issue #1019)。
/// 各 scope 内で `.claude` を先頭に並べ、`(scope, id)` の first-wins 重複排除で `.claude` を
/// 優先させる。Codex は `.codex/skills` (ユーザー指定) と公式の `.agents/skills` の両方を走査。
/// project root が空ならユーザースコープのみ。
fn source_roots(project_root: &str) -> Vec<(&'static str, &'static str, PathBuf)> {
    let home = config_paths::home_dir();
    let pr = project_root.trim();
    let mut roots: Vec<(&'static str, &'static str, PathBuf)> = Vec::new();
    // project = ファイルツリーで今開いている作業フォルダ。.claude 優先 → .codex → .agents。
    if !pr.is_empty() {
        let p = Path::new(pr);
        roots.push(("claude", "project", p.join(".claude").join("skills")));
        roots.push(("codex", "project", p.join(".codex").join("skills")));
        roots.push(("codex", "project", p.join(".agents").join("skills")));
    }
    // user (home) も同じ優先順。
    roots.push(("claude", "user", home.join(".claude").join("skills")));
    roots.push(("codex", "user", home.join(".codex").join("skills")));
    roots.push(("codex", "user", home.join(".agents").join("skills")));
    roots
}

/// Claude / Codex の取り込み元 skill を列挙する。(source, id) で重複排除 (project 優先)。
#[tauri::command]
pub async fn api_agent_skill_sources_list(
    state: State<'_, AppState>,
) -> CommandResult<Vec<ImportableSkill>> {
    let project_root = current_project_root(&state.project_root).unwrap_or_default();
    let imported: std::collections::HashSet<String> =
        list_skills_in(&config_paths::vibe_skills_dir())
            .await
            .into_iter()
            .map(|s| s.id)
            .collect();

    // priority 順 (claude → codex, project → user) に flat 収集してから (scope, id) で dedup。
    let mut raw: Vec<(&'static str, &'static str, ApiAgentSkillMeta)> = Vec::new();
    for (source, scope, root) in source_roots(&project_root) {
        for meta in list_skills_in(&root).await {
            raw.push((source, scope, meta));
        }
    }
    Ok(dedup_by_scope_id(raw, &imported))
}

/// `(scope, id)` の first-wins 重複排除。`source_roots` が各 scope 内で `.claude` を先頭に
/// 並べるため、同名 skill では `.claude` が勝つ (Issue #1019)。
fn dedup_by_scope_id(
    raw: Vec<(&str, &str, ApiAgentSkillMeta)>,
    imported: &std::collections::HashSet<String>,
) -> Vec<ImportableSkill> {
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut out: Vec<ImportableSkill> = Vec::new();
    for (source, scope, meta) in raw {
        if !seen.insert((scope.to_string(), meta.id.clone())) {
            continue; // 同 scope の同 id は先勝ち (= .claude 優先)
        }
        out.push(ImportableSkill {
            imported: imported.contains(&meta.id),
            id: meta.id,
            name: meta.name,
            description: meta.description,
            source: source.to_string(),
            scope: scope.to_string(),
        });
    }
    out.sort_by_key(|a| (a.scope.clone(), a.id.clone()));
    out
}

/// 指定 skill を取り込み元から専用フォルダへコピー (snapshot) する。
#[tauri::command]
pub async fn api_agent_skill_import(
    state: State<'_, AppState>,
    req: ImportSkillRequest,
) -> CommandResult<ApiAgentSkillMeta> {
    if !is_valid_id_segment(&req.id) {
        return Err(CommandError::validation("invalid skill id"));
    }
    if req.source != "claude" && req.source != "codex" {
        return Err(CommandError::validation("invalid source"));
    }
    let project_root = current_project_root(&state.project_root).unwrap_or_default();

    // source の各 root を project 優先で走査し、最初に見つかった SKILL.md を採用する。
    let mut body: Option<String> = None;
    for (source, _scope, root) in source_roots(&project_root) {
        if source != req.source {
            continue;
        }
        let Ok(root_canon) = fs::canonicalize(&root).await else {
            continue;
        };
        let md = root.join(&req.id).join("SKILL.md");
        if let Some(b) = read_skill_md_within(&root_canon, &md).await {
            body = Some(b);
            break;
        }
    }
    let Some(body) = body else {
        return Err(CommandError::not_found("source skill not found"));
    };

    let dest_dir = config_paths::vibe_skills_dir().join(&req.id);
    fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    atomic_write(&dest_dir.join("SKILL.md"), body.as_bytes())
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?;

    let (name, description) = parse_skill_meta(&req.id, &body);
    Ok(ApiAgentSkillMeta {
        id: req.id,
        name,
        description,
    })
}

/// 専用フォルダから import 済み skill を削除する。
#[tauri::command]
pub async fn api_agent_skill_remove(id: String) -> CommandResult<()> {
    if !is_valid_id_segment(&id) {
        return Err(CommandError::validation("invalid skill id"));
    }
    let dir = config_paths::vibe_skills_dir().join(&id);
    match fs::remove_dir_all(&dir).await {
        Ok(()) | Err(_) => Ok(()), // 不在は成功扱い (冪等)
    }
}

/// dest の現在内容 (None=不在) と新 body から materialize 後のステータスを決める純関数。
/// 内容一致なら Unchanged (idempotent)、不在なら Created、差分ありは Updated。
fn apply_status(existing: Option<&str>, body: &str) -> SkillApplyStatus {
    match existing {
        None => SkillApplyStatus::Created,
        Some(cur) if cur == body => SkillApplyStatus::Unchanged,
        Some(_) => SkillApplyStatus::Updated,
    }
}

/// Issue #1119: 選択 skill を現在のプロジェクトの `.claude/skills/<id>/SKILL.md` へ materialize する。
/// claude/codex は起動時に `.claude/skills` を自動探索するため、これで CLI エージェントでも
/// skill が効く。idempotent (内容一致は Unchanged で書かない)。
///
/// セキュリティ (PR #1120 review): 読み込み側 `read_skill_md_within` と対称に、**書き込み先**も
/// project root を canonicalize して「materialize 先が project 配下に収まる」ことを検証する。
/// `.claude` / `.claude/skills` / `.claude/skills/<id>` に symlink が仕込まれて project 外を
/// 指す場合は Unsafe で拒否し、SKILL.md 本文を外部へ書き出さない。
#[tauri::command]
pub async fn api_agent_skill_apply_to_project(
    state: State<'_, AppState>,
    skill_ids: Vec<String>,
) -> CommandResult<Vec<SkillApplyResult>> {
    let project_root = current_project_root(&state.project_root).unwrap_or_default();
    let pr = project_root.trim();
    if pr.is_empty() {
        return Err(CommandError::validation("no project open"));
    }
    // 書き込み先 escape を防ぐため project root を canonicalize しておく。
    let proj_canon = fs::canonicalize(pr)
        .await
        .map_err(|_| CommandError::validation("project root not found"))?;
    let src_dir = config_paths::vibe_skills_dir();
    let src_canon = fs::canonicalize(&src_dir).await.ok();
    let claude_skills = proj_canon.join(".claude").join("skills");

    let mut out: Vec<SkillApplyResult> = Vec::new();
    for id in skill_ids {
        if !is_valid_id_segment(&id) {
            out.push(SkillApplyResult {
                id,
                status: SkillApplyStatus::Invalid,
            });
            continue;
        }
        let body = match &src_canon {
            Some(dc) => read_skill_md_within(dc, &src_dir.join(&id).join("SKILL.md")).await,
            None => None,
        };
        let Some(body) = body else {
            out.push(SkillApplyResult {
                id,
                status: SkillApplyStatus::Missing,
            });
            continue;
        };
        let dest_dir = claude_skills.join(&id);
        fs::create_dir_all(&dest_dir)
            .await
            .map_err(|e| CommandError::Io(e.to_string()))?;
        // create 後に canonicalize し、symlink を辿って project root 外へ出ていないか検証する。
        // escape していれば本文を書かずに Unsafe で記録 (読み込み側と対称な防御)。
        let dest_canon = match fs::canonicalize(&dest_dir).await {
            Ok(c) if c.starts_with(&proj_canon) => c,
            _ => {
                tracing::warn!(
                    "[api-agent] rejected skill materialize escaping project root: {}",
                    dest_dir.display()
                );
                out.push(SkillApplyResult {
                    id,
                    status: SkillApplyStatus::Unsafe,
                });
                continue;
            }
        };
        let dest_md = dest_canon.join("SKILL.md");
        let existing = fs::read_to_string(&dest_md).await.ok();
        let status = apply_status(existing.as_deref(), &body);
        if status != SkillApplyStatus::Unchanged {
            atomic_write(&dest_md, body.as_bytes())
                .await
                .map_err(|e| CommandError::internal(e.to_string()))?;
        }
        out.push(SkillApplyResult { id, status });
    }
    Ok(out)
}

// ============================================================
// 共有ヘルパ
// ============================================================

/// `dir/<id>/SKILL.md` を列挙して skill メタを返す。dir 不在時は空配列。symlink escape は除外。
async fn list_skills_in(dir: &Path) -> Vec<ApiAgentSkillMeta> {
    let Ok(dir_canon) = fs::canonicalize(dir).await else {
        return Vec::new();
    };
    let Ok(mut rd) = fs::read_dir(dir).await else {
        return Vec::new();
    };
    let mut out: Vec<ApiAgentSkillMeta> = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_valid_id_segment(&id) {
            continue;
        }
        let md = entry.path().join("SKILL.md");
        let Some(body) = read_skill_md_within(&dir_canon, &md).await else {
            continue;
        };
        let (name, description) = parse_skill_meta(&id, &body);
        out.push(ApiAgentSkillMeta {
            id,
            name,
            description,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// `dir/<id>/SKILL.md` から選択 skill + 自動 vibe-team の本文を読み込む。
async fn load_skill_bodies_from(dir: &Path, skill_ids: &[String]) -> Vec<ApiAgentSkill> {
    let mut ids: Vec<String> = Vec::new();
    for id in skill_ids {
        if is_valid_id_segment(id) && !ids.iter().any(|x| x == id) {
            ids.push(id.clone());
        }
    }
    // 計画 v2: TeamHub 参加時は vibe-team を自動追加。
    if !ids.iter().any(|i| i == VIBE_TEAM_SKILL_ID) {
        ids.push(VIBE_TEAM_SKILL_ID.to_string());
    }
    let dir_canon = fs::canonicalize(dir).await.ok();

    let mut out: Vec<ApiAgentSkill> = Vec::new();
    for id in ids {
        let disk_body = match &dir_canon {
            Some(dc) => read_skill_md_within(dc, &dir.join(&id).join("SKILL.md")).await,
            None => None,
        };
        let body = match disk_body {
            Some(b) => b,
            None if id == VIBE_TEAM_SKILL_ID => {
                crate::commands::vibe_team_skill::bundled_vibe_team_skill_text()
            }
            None => continue,
        };
        let (name, _) = parse_skill_meta(&id, &body);
        out.push(ApiAgentSkill { id, name, body });
    }
    out
}

/// canonicalize 済み skills root 配下に実体が収まる SKILL.md だけを読む。root 外を指す
/// symlink / traversal は `None` を返し読み込まない。
async fn read_skill_md_within(skills_root_canon: &Path, md_path: &Path) -> Option<String> {
    let canon = fs::canonicalize(md_path).await.ok()?;
    if !canon.starts_with(skills_root_canon) {
        tracing::warn!(
            "[api-agent] rejected skill path escaping skills root: {}",
            md_path.display()
        );
        return None;
    }
    read_capped(&canon).await.ok()
}

async fn read_capped(path: &Path) -> CommandResult<String> {
    use tokio::io::AsyncReadExt;
    // サイズキャップを I/O 段階で効かせるため先頭 MAX_SKILL_FILE_BYTES だけ読む。
    let file = fs::File::open(path)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let mut buf = Vec::new();
    file.take(MAX_SKILL_FILE_BYTES as u64)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// frontmatter (`---\nname: ...\ndescription: ...\n---`) から name / description を抽出。
/// frontmatter が無ければ id を name、最初の非空・非ヘッダ行を description にフォールバック。
fn parse_skill_meta(id: &str, body: &str) -> (String, String) {
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;

    let trimmed = body.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines().peekable();
    while let Some(l) = lines.peek() {
        let t = l.trim();
        if t.is_empty() || t.starts_with("<!--") {
            lines.next();
        } else {
            break;
        }
    }
    if lines.peek().map(|l| l.trim()) == Some("---") {
        lines.next();
        for l in lines.by_ref() {
            let t = l.trim();
            if t == "---" {
                break;
            }
            if let Some(v) = t.strip_prefix("name:") {
                name = Some(unquote(v.trim()));
            } else if let Some(v) = t.strip_prefix("description:") {
                description = Some(unquote(v.trim()));
            }
        }
    }

    let name = name
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.to_string());
    let description = description.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        body.lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("<!--") && *l != "---")
            .unwrap_or("")
            .to_string()
    });
    let description = truncate_chars(&description, 160);
    (name, description)
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests;
