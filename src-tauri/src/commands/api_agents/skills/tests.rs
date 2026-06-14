// api_agents/skills のユニットテスト (Issue #998 / #1017)。
// 親 skills.rs の private fn / 型に `use super::*` でアクセスする。

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

/// 取り込み元 root: project 指定時は project+user の Claude/Codex 計 4 root をラベル付きで返す。
#[test]
fn source_roots_cover_claude_and_codex_user_and_project() {
    let roots = source_roots("/tmp/proj");
    let labels: Vec<(&str, &str)> = roots.iter().map(|(s, sc, _)| (*s, *sc)).collect();
    assert!(labels.contains(&("claude", "project")));
    assert!(labels.contains(&("codex", "project")));
    assert!(labels.contains(&("claude", "user")));
    assert!(labels.contains(&("codex", "user")));
    // Codex は .agents/skills, Claude は .claude/skills
    let codex_proj = roots.iter().find(|(s, sc, _)| *s == "codex" && *sc == "project");
    assert!(codex_proj.unwrap().2.ends_with(".agents/skills"));
    // project 未指定なら user スコープのみ
    let user_only = source_roots("");
    assert!(user_only.iter().all(|(_, sc, _)| *sc == "user"));
}

async fn write_skill(dir: &std::path::Path, id: &str, body: &str) {
    let d = dir.join(id);
    tokio::fs::create_dir_all(&d).await.unwrap();
    tokio::fs::write(d.join("SKILL.md"), body).await.unwrap();
}

#[tokio::test]
async fn list_skills_in_enumerates_and_parses() {
    let dir = tempfile::tempdir().unwrap();
    write_skill(dir.path(), "alpha", "---\nname: Alpha\ndescription: a\n---\nbody").await;
    write_skill(dir.path(), "beta", "---\nname: Beta\ndescription: b\n---\nbody").await;
    let list = list_skills_in(dir.path()).await;
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["alpha", "beta"]);
    assert_eq!(list[0].name, "Alpha");
}

#[tokio::test]
async fn list_skills_in_returns_empty_for_missing_dir() {
    assert!(list_skills_in(std::path::Path::new("/nonexistent-xyz-123")).await.is_empty());
}

#[tokio::test]
async fn load_skill_bodies_always_includes_vibe_team_via_bundle() {
    let dir = tempfile::tempdir().unwrap();
    let skills = load_skill_bodies_from(dir.path(), &["unknown".to_string()]).await;
    assert!(skills.iter().any(|s| s.id == VIBE_TEAM_SKILL_ID));
    assert!(!skills.iter().any(|s| s.id == "unknown"));
    let vt = skills.iter().find(|s| s.id == VIBE_TEAM_SKILL_ID).unwrap();
    assert!(vt.body.contains("vibe-team"));
}

#[tokio::test]
async fn load_skill_bodies_reads_disk_skill_and_rejects_traversal() {
    let dir = tempfile::tempdir().unwrap();
    write_skill(dir.path(), "my-skill", "---\nname: Mine\ndescription: d\n---\nhello body").await;
    let skills =
        load_skill_bodies_from(dir.path(), &["my-skill".to_string(), "../escape".to_string()]).await;
    let mine = skills.iter().find(|s| s.id == "my-skill").unwrap();
    assert_eq!(mine.name, "Mine");
    assert!(mine.body.contains("hello body"));
    assert!(!skills.iter().any(|s| s.id.contains("..")));
    assert!(skills.iter().any(|s| s.id == VIBE_TEAM_SKILL_ID));
}

/// security: SKILL.md が skills root 外を指す symlink の場合、本文を読み込まない。
#[cfg(unix)]
#[tokio::test]
async fn load_skill_bodies_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    tokio::fs::write(&secret, "TOP SECRET KEY").await.unwrap();
    let skills_dir = dir.path().join("skills");
    let evil = skills_dir.join("evil");
    tokio::fs::create_dir_all(&evil).await.unwrap();
    symlink(&secret, evil.join("SKILL.md")).unwrap();

    let skills = load_skill_bodies_from(&skills_dir, &["evil".to_string()]).await;
    assert!(!skills.iter().any(|s| s.id == "evil"));
    assert!(!skills.iter().any(|s| s.body.contains("TOP SECRET")));
    assert!(skills.iter().any(|s| s.id == VIBE_TEAM_SKILL_ID));
}

/// security: skills root 内に収まる正当な symlink は許可される。
#[cfg(unix)]
#[tokio::test]
async fn load_skill_bodies_allows_symlink_within_root() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let skills_dir = dir.path().join("skills");
    let real = skills_dir.join("real");
    tokio::fs::create_dir_all(&real).await.unwrap();
    tokio::fs::write(real.join("SKILL.md"), "inside body").await.unwrap();
    let alias = skills_dir.join("alias");
    tokio::fs::create_dir_all(&alias).await.unwrap();
    symlink(real.join("SKILL.md"), alias.join("SKILL.md")).unwrap();

    let skills = load_skill_bodies_from(&skills_dir, &["alias".to_string()]).await;
    let a = skills.iter().find(|s| s.id == "alias").unwrap();
    assert!(a.body.contains("inside body"));
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
