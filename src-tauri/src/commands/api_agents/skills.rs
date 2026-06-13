// api_agents/skills — SKILL.md の列挙と読み込み (Issue #998)。
//
// セキュリティ方針:
//   - 参照するのは active project root (`state` の信頼値) 配下の `.claude/skills/<id>/SKILL.md`
//     のみ。renderer からパスを受け取らない。
//   - skill id は `is_valid_id_segment` で検証し、`..` / `/` を含む traversal を拒否する。
//   - SKILL.md 読み込みはサイズ上限でキャップする (巨大ファイルでの OOM 回避)。

use crate::commands::error::{CommandError, CommandResult};
use crate::commands::validation::is_valid_id_segment;
use crate::state::{current_project_root, AppState};
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::fs;

use super::types::{ApiAgentSkill, ApiAgentSkillMeta};

/// 1 つの SKILL.md から読み込む最大バイト数。context budget (`MAX_SKILL_BYTES`) とは別で、
/// ここでは「異常に巨大なファイルを丸読みしない」ための I/O 上限。
const MAX_SKILL_FILE_BYTES: usize = 256 * 1024;

/// TeamHub 参加時に自動追加する skill。
pub(super) const VIBE_TEAM_SKILL_ID: &str = "vibe-team";

fn skills_root(project_root: &str) -> PathBuf {
    Path::new(project_root).join(".claude").join("skills")
}

/// active project の `.claude/skills/*/SKILL.md` を列挙し、選択可能な skill 一覧を返す。
/// プロジェクト未選択 / skills ディレクトリ無しのときは空配列。
#[tauri::command]
pub async fn api_agent_skill_list(
    state: State<'_, AppState>,
) -> CommandResult<Vec<ApiAgentSkillMeta>> {
    let root = current_project_root(&state.project_root).unwrap_or_default();
    let root = root.trim();
    if root.is_empty() {
        return Ok(Vec::new());
    }
    let dir = skills_root(root);
    let mut rd = match fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()), // skills ディレクトリが無い
    };
    let mut out: Vec<ApiAgentSkillMeta> = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?
    {
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_valid_id_segment(&id) {
            continue;
        }
        let md = entry.path().join("SKILL.md");
        if !fs::try_exists(&md).await.unwrap_or(false) {
            continue;
        }
        let body = read_capped(&md).await.unwrap_or_default();
        let (name, description) = parse_skill_meta(&id, &body);
        out.push(ApiAgentSkillMeta {
            id,
            name,
            description,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// `api_agent_send` から呼ぶ内部ヘルパ。選択された `skill_ids` + 自動 `vibe-team` の
/// `SKILL.md` 本文を読み込んで返す。無効 id / 不在ファイルはスキップ。`vibe-team` だけは
/// ディスクに無ければバンドル本文へフォールバックする。
pub(super) async fn load_skill_bodies(project_root: &str, skill_ids: &[String]) -> Vec<ApiAgentSkill> {
    let root = project_root.trim();
    // 重複排除しつつ順序を保つ。
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

    let mut out: Vec<ApiAgentSkill> = Vec::new();
    for id in ids {
        let disk_body = if root.is_empty() {
            None
        } else {
            read_capped(&skills_root(root).join(&id).join("SKILL.md"))
                .await
                .ok()
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

async fn read_capped(path: &Path) -> CommandResult<String> {
    let bytes = fs::read(path)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let slice = if bytes.len() > MAX_SKILL_FILE_BYTES {
        &bytes[..MAX_SKILL_FILE_BYTES]
    } else {
        &bytes[..]
    };
    // 上限でのバイト境界切断は from_utf8_lossy が U+FFFD で吸収する。
    Ok(String::from_utf8_lossy(slice).to_string())
}

/// frontmatter (`---\nname: ...\ndescription: ...\n---`) から name / description を抽出。
/// frontmatter が無ければ id を name、最初の非空・非ヘッダ行を description にフォールバック。
fn parse_skill_meta(id: &str, body: &str) -> (String, String) {
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;

    let trimmed = body.trim_start_matches('\u{feff}');
    // HTML コメント行 (vibe-team の version マーカー等) は frontmatter 検出前にスキップ。
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
        lines.next(); // opening ---
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
    // description は selector の subtitle 用途なので適度に短縮。
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
mod tests {
    use super::*;

    #[test]
    fn parse_meta_reads_frontmatter() {
        let body = "---\nname: My Skill\ndescription: \"Does a thing\"\n---\n# Heading\nbody text";
        let (name, desc) = parse_skill_meta("my-skill", body);
        assert_eq!(name, "My Skill");
        assert_eq!(desc, "Does a thing");
    }

    #[test]
    fn parse_meta_skips_leading_html_comment() {
        let body = "<!-- vibe-team-skill-version: 1.6.3 -->\n---\nname: vibe-team\ndescription: team rules\n---\nbody";
        let (name, desc) = parse_skill_meta("vibe-team", body);
        assert_eq!(name, "vibe-team");
        assert_eq!(desc, "team rules");
    }

    #[test]
    fn parse_meta_falls_back_without_frontmatter() {
        let body = "# Title\n\nFirst real line describes it.";
        let (name, desc) = parse_skill_meta("plain", body);
        assert_eq!(name, "plain");
        assert_eq!(desc, "First real line describes it.");
    }

    #[tokio::test]
    async fn load_skill_bodies_always_includes_vibe_team_via_bundle() {
        // 存在しない root なのでディスク読み込みは全て失敗するが、vibe-team は
        // バンドル本文でフォールバックされて必ず 1 件返る。
        let skills = load_skill_bodies("/nonexistent-root-xyz", &["unknown".to_string()]).await;
        assert!(skills.iter().any(|s| s.id == VIBE_TEAM_SKILL_ID));
        assert!(!skills.iter().any(|s| s.id == "unknown"));
        let vt = skills.iter().find(|s| s.id == VIBE_TEAM_SKILL_ID).unwrap();
        assert!(vt.body.contains("vibe-team"));
    }

    #[tokio::test]
    async fn load_skill_bodies_reads_disk_skill_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let skill_dir = skills_root(&root).join("my-skill");
        tokio::fs::create_dir_all(&skill_dir).await.unwrap();
        tokio::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Mine\ndescription: d\n---\nhello body",
        )
        .await
        .unwrap();

        let skills = load_skill_bodies(
            &root,
            &["my-skill".to_string(), "../escape".to_string()],
        )
        .await;
        let mine = skills.iter().find(|s| s.id == "my-skill").unwrap();
        assert_eq!(mine.name, "Mine");
        assert!(mine.body.contains("hello body"));
        // traversal id は弾かれる
        assert!(!skills.iter().any(|s| s.id.contains("..")));
        // vibe-team は自動追加
        assert!(skills.iter().any(|s| s.id == VIBE_TEAM_SKILL_ID));
    }

    #[tokio::test]
    async fn read_capped_limits_size() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.md");
        let big = "x".repeat(MAX_SKILL_FILE_BYTES * 2);
        tokio::fs::write(&p, &big).await.unwrap();
        let out = read_capped(&p).await.unwrap();
        assert!(out.len() <= MAX_SKILL_FILE_BYTES);
    }
}
