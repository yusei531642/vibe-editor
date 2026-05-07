//! 動的ロール定義の必須テンプレ + 曖昧名 + Worktree Isolation Rule の validation。Issue #508。
//!
//! `instruction_lint` (Issue #519) は「禁止句が含まれているか」を見るが、本モジュールは
//! 逆向きの責務 — 「必須要素が **欠けていないか**」を見る。両者を併用することで Leader が
//! 雑な instructions を投げてきても worker の品質を一定以上に保つ。
//!
//! 設計:
//! - DENY: instructions が極端に短い (< MIN_INSTRUCTIONS_BYTES) もしくは 4 軸セクションが
//!   完全に欠如 → recruit 拒否 (`recruit_role_too_vague`)。
//! - WARN: 1〜3 軸欠落 / 順序不正 / 中身が薄いセクション / Worktree Isolation Rule トークン
//!   欠落 / 曖昧 label → 採用は通すが recruit response に warning を載せる。
//! - 4 軸見出しは英語固定 (`### Responsibilities` / `### Inputs` / `### Outputs` /
//!   `### Done Criteria`)。`Done Criteria` の alias として `Definition of Done` / `DoD` も許容。
//! - Worktree Isolation Rule の固定形は skill_integrator (#508 整合) との合意済仕様:
//!   `git worktree add F:/vive-editor-worktrees/<short_id> -b <branch> origin/main`
//!   + `Set-Location F:/vive-editor-worktrees/<short_id>` を必須とする。
//!
//! 公開 API:
//! - `validate_template(label, instructions, instructions_ja)` → TemplateReport

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateLevel {
    Warn,
    Deny,
}

#[derive(Debug, Clone, Serialize)]
pub struct TemplateFinding {
    pub level: TemplateLevel,
    pub category: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TemplateReport {
    pub findings: Vec<TemplateFinding>,
}

impl TemplateReport {
    pub fn has_deny(&self) -> bool {
        self.findings.iter().any(|f| f.level == TemplateLevel::Deny)
    }

    pub fn warnings(&self) -> Vec<&TemplateFinding> {
        self.findings
            .iter()
            .filter(|f| f.level == TemplateLevel::Warn)
            .collect()
    }

    pub fn deny_message(&self) -> String {
        let parts: Vec<String> = self
            .findings
            .iter()
            .filter(|f| f.level == TemplateLevel::Deny)
            .map(|f| format!("[{}] {}", f.category, f.detail))
            .collect();
        format!(
            "instructions do not satisfy the dynamic role template: {}",
            parts.join("; ")
        )
    }

    pub fn warn_message(&self) -> Option<String> {
        let parts: Vec<String> = self
            .warnings()
            .iter()
            .map(|f| format!("[{}] {}", f.category, f.detail))
            .collect();
        if parts.is_empty() {
            None
        } else {
            Some(format!(
                "dynamic role template warnings (continuing recruit): {}",
                parts.join("; ")
            ))
        }
    }
}

/// 必須最小バイト数 (combined instructions の trim 後)。これ未満は実質「中身ゼロ」とみなす。
const MIN_INSTRUCTIONS_BYTES: usize = 80;

/// 各セクションの最小本文バイト数 (heading 後の trim 後)。
const MIN_SECTION_CONTENT_BYTES: usize = 20;

/// 必須 4 軸 (canonical 順)。validation はこの順序で並んでいることも警告対象にする。
const REQUIRED_SECTIONS: &[&str] = &["Responsibilities", "Inputs", "Outputs", "Done Criteria"];

/// `Done Criteria` の alias (英語表記ゆれ吸収)。
const DONE_CRITERIA_ALIASES: &[&str] = &["Definition of Done", "DoD"];

/// 曖昧 label のパターン (lowercase / ASCII / CJK 混在)。完全一致 or 含有でヒット。
const VAGUE_LABEL_PATTERNS: &[&str] = &[
    "general",
    "support",
    "miscellaneous",
    "general purpose",
    "general-purpose",
    "なんでも",
    "何でもやる",
    "何でも屋",
    "万屋",
    "汎用",
    "便利屋",
    "サポート係",
];

/// Worktree Isolation Rule の必須トークン (skill_integrator との合意仕様)。
/// 各トークンは soft-match (case-sensitive、ASCII)。日本語 instructions に断片があれば pass。
struct WorktreeTokenSpec {
    name: &'static str,
    matcher: fn(&str) -> bool,
}

const WORKTREE_TOKENS: &[WorktreeTokenSpec] = &[
    WorktreeTokenSpec {
        name: "git worktree add",
        matcher: |t| t.contains("git worktree add"),
    },
    WorktreeTokenSpec {
        name: "origin/main",
        matcher: |t| t.contains("origin/main"),
    },
    WorktreeTokenSpec {
        name: "Set-Location (or cd)",
        matcher: |t| t.contains("Set-Location") || has_cd_token(t),
    },
    WorktreeTokenSpec {
        name: "-b <branch>",
        matcher: |t| {
            // ` -b ` を中心に行頭 / 行末ケースも許容
            t.contains(" -b ")
                || t.contains(" -b\n")
                || t.lines().any(|l| l.trim_start().starts_with("-b "))
        },
    },
    WorktreeTokenSpec {
        name: "vive-editor-worktrees",
        matcher: |t| t.contains("vive-editor-worktrees"),
    },
];

/// `cd <dir>` 形式の存在を検査 (PowerShell の `Set-Location` 代替)。
/// 単に `t.contains("cd ")` だと "include" / "code" などに誤マッチするので、
/// 行頭 trim 後に `cd ` で始まる行を探す。
fn has_cd_token(text: &str) -> bool {
    text.lines().any(|l| {
        let trimmed = l.trim_start();
        trimmed.starts_with("cd ") || trimmed == "cd"
    })
}

#[derive(Debug, Clone)]
struct SectionMatch {
    canonical: &'static str,
    content_bytes: usize,
}

/// `### <Section>` 形式の見出しを順に検出。alias は canonical 名にマッピング。
fn find_sections(text: &str) -> Vec<SectionMatch> {
    let lines: Vec<&str> = text.lines().collect();
    let mut headings: Vec<(usize, &'static str)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("### ") {
            continue;
        }
        let after = trimmed.trim_start_matches('#').trim_start();
        let canonical: Option<&'static str> = if after.starts_with("Responsibilities") {
            Some("Responsibilities")
        } else if after.starts_with("Inputs") {
            Some("Inputs")
        } else if after.starts_with("Outputs") {
            Some("Outputs")
        } else if after.starts_with("Done Criteria") {
            Some("Done Criteria")
        } else if DONE_CRITERIA_ALIASES.iter().any(|a| after.starts_with(a)) {
            Some("Done Criteria")
        } else {
            None
        };
        if let Some(name) = canonical {
            headings.push((i, name));
        }
    }
    let mut out = Vec::with_capacity(headings.len());
    for (idx, &(line_idx, name)) in headings.iter().enumerate() {
        let next_line = headings
            .get(idx + 1)
            .map(|&(li, _)| li)
            .unwrap_or(lines.len());
        let mut bytes = 0;
        for li in (line_idx + 1)..next_line {
            // 次の H2/H1 見出しでも区切る (緩い fence)
            let lt = lines[li].trim_start();
            if lt.starts_with("## ") || lt.starts_with("# ") {
                break;
            }
            bytes += lines[li].trim().len();
        }
        out.push(SectionMatch {
            canonical: name,
            content_bytes: bytes,
        });
    }
    out
}

/// セクション群が REQUIRED_SECTIONS の順 (Responsibilities → Inputs → Outputs → Done Criteria)
/// に並んでいるかを判定。重複登場した場合は最初の登場順を使う。
fn is_in_required_order(sections: &[SectionMatch]) -> bool {
    let mut last_rank: i32 = -1;
    for s in sections {
        if let Some(rank) = REQUIRED_SECTIONS.iter().position(|n| *n == s.canonical) {
            let r = rank as i32;
            if r < last_rank {
                return false;
            }
            last_rank = r;
        }
    }
    true
}

/// 動的ロール定義 (label / instructions / instructions_ja) を全項目検査して TemplateReport を返す。
pub fn validate_template(
    label: &str,
    instructions: &str,
    instructions_ja: Option<&str>,
) -> TemplateReport {
    let mut findings: Vec<TemplateFinding> = Vec::new();

    // combined テキスト (instructions + instructions_ja を改行連結)。Worktree Isolation Rule
    // のトークンや 4 軸見出しは英語側に書かれていれば pass。日本語側だけにある場合も同様に pass。
    let combined: String = match instructions_ja {
        Some(ja) if !ja.is_empty() => format!("{}\n{}", instructions, ja),
        _ => instructions.to_string(),
    };

    // ===== 1. 極端に短い → DENY =====
    let trimmed_len = combined.trim().len();
    if trimmed_len < MIN_INSTRUCTIONS_BYTES {
        findings.push(TemplateFinding {
            level: TemplateLevel::Deny,
            category: "too_short",
            detail: format!(
                "instructions are too short: {} bytes (minimum {})",
                trimmed_len, MIN_INSTRUCTIONS_BYTES
            ),
        });
        // 中身が無いケースは他チェックを重ねても意味が薄いので早期 return。
        return TemplateReport { findings };
    }

    // ===== 2. 必須 4 軸セクション =====
    let sections = find_sections(&combined);
    let present: std::collections::BTreeSet<&'static str> =
        sections.iter().map(|s| s.canonical).collect();
    let missing: Vec<&&'static str> = REQUIRED_SECTIONS
        .iter()
        .filter(|n| !present.contains(*n))
        .collect();

    // 4 軸全欠 → DENY
    if present.is_empty() {
        findings.push(TemplateFinding {
            level: TemplateLevel::Deny,
            category: "missing_all_sections",
            detail: format!(
                "instructions must contain all 4 sections (`### Responsibilities` / `### Inputs` / `### Outputs` / `### Done Criteria`); none were found"
            ),
        });
        // 全欠ケースも他チェックは ノイズになるので早期 return。
        return TemplateReport { findings };
    }

    // 1〜3 軸欠 → WARN
    for name in missing {
        findings.push(TemplateFinding {
            level: TemplateLevel::Warn,
            category: "missing_section",
            detail: format!("missing required section: '### {}'", name),
        });
    }

    // 順序チェック
    if !is_in_required_order(&sections) {
        findings.push(TemplateFinding {
            level: TemplateLevel::Warn,
            category: "section_order",
            detail: format!(
                "required sections must appear in order: {}",
                REQUIRED_SECTIONS.join(" → ")
            ),
        });
    }

    // セクション中身の長さチェック
    for s in &sections {
        if s.content_bytes < MIN_SECTION_CONTENT_BYTES {
            findings.push(TemplateFinding {
                level: TemplateLevel::Warn,
                category: "thin_section",
                detail: format!(
                    "section '### {}' has too little content ({} bytes, minimum {})",
                    s.canonical, s.content_bytes, MIN_SECTION_CONTENT_BYTES
                ),
            });
        }
    }

    // ===== 3. Worktree Isolation Rule トークン =====
    let missing_tokens: Vec<&'static str> = WORKTREE_TOKENS
        .iter()
        .filter(|spec| !(spec.matcher)(&combined))
        .map(|spec| spec.name)
        .collect();
    if !missing_tokens.is_empty() {
        findings.push(TemplateFinding {
            level: TemplateLevel::Warn,
            category: "missing_worktree_rule",
            detail: format!(
                "instructions should include the Worktree Isolation Rule (missing tokens: {})",
                missing_tokens.join(", ")
            ),
        });
    }

    // ===== 4. 曖昧 label =====
    let label_lower = label.to_ascii_lowercase();
    let label_norm = label_lower.trim();
    for pat in VAGUE_LABEL_PATTERNS {
        let pat_lower = pat.to_ascii_lowercase();
        let hit = label_norm == pat_lower
            // ASCII patterns: word containment is acceptable.
            // CJK patterns: just `contains` covers both 部分一致 and 完全一致.
            || label_norm.contains(&pat_lower);
        if hit {
            findings.push(TemplateFinding {
                level: TemplateLevel::Warn,
                category: "vague_label",
                detail: format!(
                    "label '{}' is too vague (matches '{}'); pick a role-specific name",
                    label, pat
                ),
            });
            break;
        }
    }

    let _ = sections; // silence dead_code in some configurations
    TemplateReport { findings }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4 軸 + Worktree Isolation Rule を全部備えたフル instructions を作る (正常パスの基準)。
    fn full_instructions() -> String {
        r#"### Responsibilities
- Implement the team_recruit lint hook for instruction_lint findings.
- Surface warnings in the recruit response.

### Inputs
- The recruit args (label, description, instructions, instructions_ja).
- The current dynamic role registry state.

### Outputs
- A registered dynamic role on success, or a structured RecruitError on deny.

### Done Criteria
- cargo test team_hub::protocol passes.
- typecheck passes.

## Worktree Isolation Rule
First action after recruit:

```
git worktree add F:/vive-editor-worktrees/issue-508 -b enhancement/issue-508 origin/main
Set-Location F:/vive-editor-worktrees/issue-508
```
"#.to_string()
    }

    #[test]
    fn full_instructions_pass_clean() {
        let report = validate_template("Rust TeamHub Core", &full_instructions(), None);
        assert!(
            report.findings.is_empty(),
            "full instructions should pass; got {:?}",
            report.findings
        );
    }

    #[test]
    fn empty_instructions_deny_too_short() {
        let report = validate_template("worker", "", None);
        assert!(report.has_deny());
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "too_short"));
    }

    #[test]
    fn whitespace_only_deny_too_short() {
        let report = validate_template("worker", "    \n\n  \t  \n", None);
        assert!(report.has_deny());
    }

    #[test]
    fn no_sections_at_all_deny() {
        let body = "あなたはチームの programmer。Leader からの指示を待ち、完了したら報告してください。\
                    Worktree Isolation Rule に従い git worktree add origin/main + Set-Location -b で作業領域を分ける。\
                    F:/vive-editor-worktrees/issue-N を path として使う、vive-editor-worktrees の規約は守ること。";
        let report = validate_template("programmer", body, None);
        assert!(report.has_deny());
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "missing_all_sections"));
    }

    #[test]
    fn missing_one_section_warns() {
        let body = r#"### Responsibilities
Do the thing.
- aaaaaaaaaaaaaaaaaaaa

### Inputs
Some inputs.
- bbbbbbbbbbbbbbbbbbbb

### Outputs
Some outputs.
- cccccccccccccccccccc

git worktree add F:/vive-editor-worktrees/issue-508 -b enhancement/issue-508 origin/main
Set-Location F:/vive-editor-worktrees/issue-508
"#;
        let report = validate_template("programmer", body, None);
        assert!(!report.has_deny(), "should warn, not deny: {:?}", report.findings);
        let names: Vec<&'static str> =
            report.findings.iter().map(|f| f.category).collect();
        assert!(names.contains(&"missing_section"));
    }

    #[test]
    fn done_criteria_alias_is_accepted() {
        let body = r#"### Responsibilities
Do the thing properly with full context.

### Inputs
Various inputs are passed in.

### Outputs
Outputs go here.

### Definition of Done
We are done when tests pass.

git worktree add F:/vive-editor-worktrees/issue-508 -b enhancement/issue-508 origin/main
Set-Location F:/vive-editor-worktrees/issue-508
"#;
        let report = validate_template("programmer", body, None);
        // missing_section は出ないはず (DoD alias で Done Criteria 扱いになるため)
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.category == "missing_section"),
            "DoD alias should be accepted; got {:?}",
            report.findings
        );
    }

    #[test]
    fn out_of_order_sections_warn() {
        let body = r#"### Inputs
Some inputs first by mistake.

### Responsibilities
Then responsibilities.

### Outputs
Outputs.

### Done Criteria
DoD.

git worktree add F:/vive-editor-worktrees/issue-508 -b enhancement/issue-508 origin/main
Set-Location F:/vive-editor-worktrees/issue-508
"#;
        let report = validate_template("programmer", body, None);
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "section_order"));
    }

    #[test]
    fn thin_section_warns() {
        let body = r#"### Responsibilities
short

### Inputs
also short

### Outputs
also short

### Done Criteria
also short

git worktree add F:/vive-editor-worktrees/issue-508 -b enhancement/issue-508 origin/main
Set-Location F:/vive-editor-worktrees/issue-508
"#;
        let report = validate_template("programmer", body, None);
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "thin_section"));
    }

    #[test]
    fn missing_worktree_rule_warns() {
        // 4 軸あるが Worktree Isolation Rule のトークンが欠落
        let body = r#"### Responsibilities
Implement the feature with proper test coverage.

### Inputs
Standard recruit args.

### Outputs
A working dynamic role.

### Done Criteria
Tests pass and reviewer approves.
"#;
        let report = validate_template("programmer", body, None);
        assert!(!report.has_deny());
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "missing_worktree_rule"));
    }

    #[test]
    fn vague_label_warns() {
        let report = validate_template("Support", &full_instructions(), None);
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "vague_label"));
    }

    #[test]
    fn vague_label_japanese_warns() {
        let report = validate_template("サポート係", &full_instructions(), None);
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "vague_label"));
    }

    #[test]
    fn instructions_ja_supplements_english() {
        // 英語 instructions に worktree rule が無くても、ja 側に書いてあれば pass
        let en = r#"### Responsibilities
Implement the feature with proper test coverage.

### Inputs
Standard recruit args.

### Outputs
A working dynamic role.

### Done Criteria
Tests pass and reviewer approves.
"#;
        let ja = "Worktree Isolation Rule に従う: git worktree add F:/vive-editor-worktrees/issue-508 -b foo origin/main、その後 Set-Location する。";
        let report = validate_template("programmer", en, Some(ja));
        assert!(!report
            .findings
            .iter()
            .any(|f| f.category == "missing_worktree_rule"));
    }

    #[test]
    fn deny_message_is_human_readable() {
        let report = validate_template("worker", "", None);
        let msg = report.deny_message();
        assert!(msg.contains("instructions"));
        assert!(msg.contains("too_short"));
    }

    #[test]
    fn warn_message_is_none_when_clean() {
        let report = validate_template("Rust TeamHub Core", &full_instructions(), None);
        assert!(report.warn_message().is_none());
    }

    #[test]
    fn warn_message_collects_multiple_findings() {
        let body = r#"### Responsibilities
Do something useful here for the worker context.

### Inputs
Some input.
"#;
        let report = validate_template("Support", body, None);
        let msg = report.warn_message().unwrap_or_default();
        assert!(msg.contains("missing_section"));
        assert!(msg.contains("vague_label"));
    }
}
