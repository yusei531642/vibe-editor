//! 動的ロール同士の責務境界 lint。Issue #517。
//!
//! `instruction_lint` (#519) が「禁止句が含まれているか」、`role_template` (#508) が
//! 「必須要素が欠けていないか」を見る逆責務を持つのに対し、本モジュールは **「他の
//! 既存メンバーと責務範囲が重複していないか」** を見る。Leader / HR が同質ロールの
//! 重複を量産するのを recruit / assign_task 段階で warn する。
//!
//! 設計:
//! - **WARN のみ** (DENY しない)。偽陽性で正当な採用を妨げない方針 (`tasks/issue-517/plan.md`)。
//! - 類似度: char trigram の Jaccard (Σ |A∩B| / |A∪B|)。トークナイザ不要で
//!   日本語/英語混在テキストにそのまま使える。
//! - 既存メンバーが居ない / 採用 1 人目は OK。
//! - 禁止キーワード (`general` / `support` / `汎用` / `何でも` / `便利屋` / `サポート係`) を
//!   role_id / label / description / instructions のどれかに含むと別途 warn。
//!
//! 公開 API:
//! - `RoleSnapshot` — 1 ロール分の検査対象テキスト。
//! - `compute_role_overlap(new, existing)` — recruit 段階の重複検出。
//! - `compute_task_overlap(description, members)` — assign_task 段階の領域重複検出。
//! - `vague_keyword_findings(label, description, instructions)` — 単独 lint。

use serde::Serialize;
use std::collections::HashSet;

/// Jaccard 類似度の WARN 閾値 (recruit 重複検出用)。
/// 0.45 は label / description / instructions の合算が約半分一致する水準。
/// 偽陽性を避けるため、低過ぎず高過ぎず。
pub const RECRUIT_OVERLAP_THRESHOLD: f64 = 0.45;

/// task description × 既存 worker 責務の Jaccard 閾値。
/// description は短い (= trigram 集合が小さい) のに対し worker instructions は長いので、
/// union が膨らんで Jaccard 値が低めに出る傾向がある。RECRUIT より緩めの 0.30 を採用し、
/// 共通キーワードベースの「領域またぎ」を拾えるようにする。
pub const ASSIGN_OVERLAP_THRESHOLD: f64 = 0.30;

/// Trigram の最小チャンク長 (`text.chars().count() < N` ならそもそも比較しない)。
/// 短文同士の偽 1.0 を避ける。
const MIN_CHARS_FOR_TRIGRAMS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleLintLevel {
    Warn,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoleLintFinding {
    pub level: RoleLintLevel,
    pub category: &'static str,
    pub detail: String,
    /// 0.0–1.0 の類似度。`vague_keyword` 系は None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f64>,
    /// 衝突相手 (重複系のみ)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_role_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RoleLintReport {
    pub findings: Vec<RoleLintFinding>,
}

impl RoleLintReport {
    /// Findings を `[category] detail` 形式の文字列配列に整形する。
    /// recruit / assign_task 両方の response / event payload で同じ書式を使うために共通化。
    pub fn finding_strings(&self) -> Vec<String> {
        self.findings
            .iter()
            .map(|f| format!("[{}] {}", f.category, f.detail))
            .collect()
    }

    /// 警告がある場合だけ 1 行サマリを返す。recruit response の `boundaryWarningMessage` 等で使用。
    pub fn warn_message(&self, prefix: &str) -> Option<String> {
        let parts = self.finding_strings();
        if parts.is_empty() {
            None
        } else {
            Some(format!("{}: {}", prefix, parts.join("; ")))
        }
    }

    pub fn is_empty(&self) -> bool {
        self.findings.is_empty()
    }
}

/// 1 ロール分の検査対象テキスト。
#[derive(Debug, Clone)]
pub struct RoleSnapshot {
    pub role_id: String,
    pub label: String,
    pub description: String,
    pub instructions: String,
}

impl RoleSnapshot {
    /// 全テキストを連結した正規化済み文字列を返す (類似度計算用)。
    /// role_id は意図的に含めない — 識別子の表記差 (alice vs bob 等) で
    /// 同一責務でも類似度が下がるのを避けるため。責務テキストだけで比較する。
    fn combined(&self) -> String {
        normalize(&format!(
            "{}\n{}\n{}",
            self.label, self.description, self.instructions
        ))
    }
}

/// 入力を正規化: lowercase + 全角→半角 + 句読点 → 空白 + 空白圧縮。
/// `instruction_lint` の normalize と論理は同じだが、独立に保つ (将来トークナイザを
/// 差し替える可能性のある別軸)。
pub fn normalize(text: &str) -> String {
    let mut buf = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch == '\u{3000}' {
            buf.push(' ');
            continue;
        }
        let code = ch as u32;
        let mapped = if (0xFF01..=0xFF5E).contains(&code) {
            char::from_u32(code - 0xFEE0).unwrap_or(ch)
        } else {
            ch
        };
        let mapped = match mapped {
            '。' | '、' | '．' | '，' | '・' | ':' | ';' | '：' | '；' | '!' | '?'
            | '！' | '？' | ',' | '.' | '\t' | '\n' | '\r' | '"' | '\'' | '`'
            | '(' | ')' | '[' | ']' | '{' | '}' | '「' | '」' | '『' | '』'
            | '【' | '】' | '〈' | '〉' | '《' | '》' | '“' | '”' | '‘' | '’' => ' ',
            other => other,
        };
        for low in mapped.to_lowercase() {
            buf.push(low);
        }
    }
    let mut out = String::with_capacity(buf.len());
    let mut prev_ws = true;
    for ch in buf.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

/// 文字 3-gram の集合を返す。日本語 / 英語混在テキストでも language-agnostic に
/// 類似度を評価できる。
pub fn char_trigrams(text: &str) -> HashSet<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = HashSet::new();
    if chars.len() < 3 {
        return out;
    }
    for win in chars.windows(3) {
        out.insert(win.iter().collect::<String>());
    }
    out
}

/// Jaccard 類似度 = |A∩B| / |A∪B|。両方空なら 0.0。
pub fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// 2 つの RoleSnapshot 間の類似度を返す (0.0–1.0)。
pub fn similarity(a: &RoleSnapshot, b: &RoleSnapshot) -> f64 {
    let na = a.combined();
    let nb = b.combined();
    if na.chars().count() < MIN_CHARS_FOR_TRIGRAMS || nb.chars().count() < MIN_CHARS_FOR_TRIGRAMS {
        return 0.0;
    }
    jaccard(&char_trigrams(&na), &char_trigrams(&nb))
}

/// 曖昧キーワードリスト (vague / 汎用名)。
/// `role_template` の `VAGUE_LABEL_PATTERNS` と意図的に重なる部分があるが、
/// こちらは label だけでなく role_id / description / instructions まで広範に
/// チェックするので独立リストにする。
const VAGUE_KEYWORDS: &[&str] = &[
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

/// 曖昧キーワードを role_id / label / description / instructions のいずれかに含む場合の WARN を返す。
pub fn vague_keyword_findings(
    role_id: &str,
    label: &str,
    description: &str,
    instructions: &str,
) -> Vec<RoleLintFinding> {
    let mut findings = Vec::new();
    let combined = format!(
        "{}\n{}\n{}\n{}",
        role_id.to_ascii_lowercase(),
        label.to_ascii_lowercase(),
        description.to_ascii_lowercase(),
        instructions.to_ascii_lowercase()
    );
    let mut hit: Vec<&'static str> = Vec::new();
    for kw in VAGUE_KEYWORDS {
        let kw_lower = kw.to_ascii_lowercase();
        if combined.contains(&kw_lower) {
            hit.push(kw);
        }
    }
    if !hit.is_empty() {
        findings.push(RoleLintFinding {
            level: RoleLintLevel::Warn,
            category: "vague_keyword",
            detail: format!(
                "role contains vague / catch-all keyword(s): {} — pick a more specific responsibility scope",
                hit.join(", ")
            ),
            similarity: None,
            other_role_id: None,
        });
    }
    findings
}

/// 採用時の重複 lint。新ロール `new` と既存ロール群 `existing` の各組合せで類似度を計算し、
/// `RECRUIT_OVERLAP_THRESHOLD` 超過なら warn。
///
/// 加えて `vague_keyword_findings` も合算する。
pub fn compute_role_overlap(new: &RoleSnapshot, existing: &[RoleSnapshot]) -> RoleLintReport {
    let mut findings = vague_keyword_findings(
        &new.role_id,
        &new.label,
        &new.description,
        &new.instructions,
    );

    for other in existing {
        if other.role_id == new.role_id {
            continue;
        }
        let sim = similarity(new, other);
        if sim >= RECRUIT_OVERLAP_THRESHOLD {
            findings.push(RoleLintFinding {
                level: RoleLintLevel::Warn,
                category: "recruit_role_overlap",
                detail: format!(
                    "new role '{}' overlaps with existing '{}' by {:.0}% (Jaccard trigram); \
                     consider sharpening the responsibility boundary or reusing the existing role",
                    new.role_id,
                    other.role_id,
                    sim * 100.0
                ),
                similarity: Some(sim),
                other_role_id: Some(other.role_id.clone()),
            });
        }
    }

    RoleLintReport { findings }
}

/// 1 名分の assignee 候補 (role_id + その instructions / description)。
/// `compute_task_overlap` の入力。
#[derive(Debug, Clone)]
pub struct MemberSnapshot {
    pub role_id: String,
    pub instructions: String,
    pub description: String,
}

/// `team_assign_task` の宛先 worker `target_role_id` と他 worker の責務範囲が
/// task description と同領域に重なっていれば warn する。
///
/// 概要: task description の trigram 集合と、各 member.instructions+description の
/// trigram 集合の Jaccard を取る。target 以外で閾値超過のメンバーが居れば、
/// 「この task は target だけでなく <other> の領域にもまたがっている」 warn を返す。
///
/// target が候補リストに無い場合は空 report (= warn 無し) を返す。検証は呼び出し側で行う。
pub fn compute_task_overlap(
    description: &str,
    target_role_id: &str,
    members: &[MemberSnapshot],
) -> RoleLintReport {
    let normalized_desc = normalize(description);
    if normalized_desc.chars().count() < MIN_CHARS_FOR_TRIGRAMS {
        return RoleLintReport::default();
    }
    let desc_grams = char_trigrams(&normalized_desc);

    let mut findings = Vec::new();
    for m in members {
        if m.role_id == target_role_id {
            continue;
        }
        let combined = normalize(&format!("{}\n{}", m.description, m.instructions));
        if combined.chars().count() < MIN_CHARS_FOR_TRIGRAMS {
            continue;
        }
        let other_grams = char_trigrams(&combined);
        let sim = jaccard(&desc_grams, &other_grams);
        if sim >= ASSIGN_OVERLAP_THRESHOLD {
            findings.push(RoleLintFinding {
                level: RoleLintLevel::Warn,
                category: "assign_task_overlap",
                detail: format!(
                    "task description overlaps with '{}' responsibility by {:.0}%; \
                     this task may belong to '{}' rather than '{}', or should be split",
                    m.role_id,
                    sim * 100.0,
                    m.role_id,
                    target_role_id
                ),
                similarity: Some(sim),
                other_role_id: Some(m.role_id.clone()),
            });
        }
    }
    RoleLintReport { findings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(role_id: &str, label: &str, description: &str, instructions: &str) -> RoleSnapshot {
        RoleSnapshot {
            role_id: role_id.to_string(),
            label: label.to_string(),
            description: description.to_string(),
            instructions: instructions.to_string(),
        }
    }

    fn member(role_id: &str, description: &str, instructions: &str) -> MemberSnapshot {
        MemberSnapshot {
            role_id: role_id.to_string(),
            instructions: instructions.to_string(),
            description: description.to_string(),
        }
    }

    #[test]
    fn normalize_lowercases_and_collapses() {
        assert_eq!(normalize("A  B\n\nC"), "a b c");
        assert_eq!(normalize("ＡＢＣ"), "abc");
    }

    #[test]
    fn char_trigrams_basic() {
        let g = char_trigrams("abcd");
        assert!(g.contains("abc"));
        assert!(g.contains("bcd"));
        assert_eq!(g.len(), 2);
    }

    #[test]
    fn jaccard_identical_is_one() {
        let g = char_trigrams("abcdefgh");
        assert!((jaccard(&g, &g) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn jaccard_disjoint_is_zero() {
        let a = char_trigrams("abcdefgh");
        let b = char_trigrams("xyzwvuts");
        assert!(jaccard(&a, &b) < 0.05);
    }

    #[test]
    fn similarity_identical_roles() {
        let a = snap(
            "alice",
            "Canvas Investigator",
            "Canvas モードの不具合調査",
            "canvas/CanvasMode.tsx を読んで再現手順をまとめる",
        );
        let b = snap(
            "bob",
            "Canvas Investigator",
            "Canvas モードの不具合調査",
            "canvas/CanvasMode.tsx を読んで再現手順をまとめる",
        );
        let s = similarity(&a, &b);
        assert!(s > 0.9, "expected near 1.0, got {s}");
    }

    #[test]
    fn similarity_distinct_roles_low() {
        let a = snap(
            "alice",
            "Rust TeamHub Core",
            "vibe-team の TeamHub プロトコル中核 (recruit / send / assign_task)",
            "src-tauri/src/team_hub/protocol/ を担当する。dynamic_role / instruction_lint を実装",
        );
        let b = snap(
            "bob",
            "Renderer Canvas UI",
            "Canvas モードの React UI コンポーネント (StageHud / TeamPresetsPanel)",
            "src/renderer/src/components/canvas/ を担当する。@xyflow/react を使う",
        );
        let s = similarity(&a, &b);
        assert!(s < 0.3, "expected low (<0.3), got {s}");
    }

    #[test]
    fn compute_role_overlap_flags_duplicate() {
        let new = snap(
            "alice2",
            "Canvas Investigator",
            "Canvas モードの不具合調査と再現手順整理",
            "canvas モジュール (Stage / xyflow) を読んでバグ再現を行う担当",
        );
        let existing = vec![snap(
            "alice",
            "Canvas Investigator",
            "Canvas モードの不具合調査",
            "canvas/Stage と xyflow を読んで再現手順をまとめる",
        )];
        let report = compute_role_overlap(&new, &existing);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.category == "recruit_role_overlap"),
            "expected recruit_role_overlap, got {:?}",
            report.findings
        );
    }

    #[test]
    fn compute_role_overlap_passes_distinct() {
        let new = snap(
            "rust_core",
            "Rust TeamHub Core",
            "vibe-team の TeamHub プロトコル中核",
            "src-tauri/src/team_hub/protocol/ を担当",
        );
        let existing = vec![snap(
            "renderer_ui",
            "Renderer Canvas UI",
            "Canvas モードの React UI コンポーネント",
            "src/renderer/src/components/canvas/ を担当する",
        )];
        let report = compute_role_overlap(&new, &existing);
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.category == "recruit_role_overlap"),
            "distinct roles must not flag overlap; got {:?}",
            report.findings
        );
    }

    #[test]
    fn compute_role_overlap_flags_vague_keyword() {
        let new = snap(
            "support_general",
            "Support",
            "なんでも対応する汎用係",
            "ユーザー要求があれば何でも対応する general purpose worker",
        );
        let report = compute_role_overlap(&new, &[]);
        assert!(report
            .findings
            .iter()
            .any(|f| f.category == "vague_keyword"));
    }

    #[test]
    fn compute_role_overlap_no_existing_no_warn() {
        let new = snap(
            "rust_core",
            "Rust TeamHub Core",
            "vibe-team の TeamHub プロトコル中核",
            "src-tauri/src/team_hub/protocol/ を担当",
        );
        let report = compute_role_overlap(&new, &[]);
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.category == "recruit_role_overlap"),
            "no existing roles → no overlap warn; got {:?}",
            report.findings
        );
    }

    #[test]
    fn compute_role_overlap_skips_same_role_id() {
        // 同 role_id 再採用 (role_id 衝突) は dynamic_role.rs 側で弾かれるが、
        // role_lint は防御的に同 id をスキップする。
        let new = snap("alice", "x", "x", "x");
        let existing = vec![snap("alice", "x", "x", "x")];
        let report = compute_role_overlap(&new, &existing);
        assert!(!report
            .findings
            .iter()
            .any(|f| f.category == "recruit_role_overlap"));
    }

    #[test]
    fn compute_task_overlap_flags_cross_boundary() {
        // task description が rust_core の責務 ("team_hub protocol") に近い領域なのに
        // 宛先が renderer_ui になっている → warn が出るべき
        let members = vec![
            member(
                "rust_core",
                "vibe-team の TeamHub プロトコル中核",
                "src-tauri/src/team_hub/protocol/ を担当 recruit send assign_task instruction_lint",
            ),
            member(
                "renderer_ui",
                "Canvas モードの React UI",
                "src/renderer/src/components/canvas/ を担当",
            ),
        ];
        let report = compute_task_overlap(
            "team_hub の protocol で recruit / send / assign_task に instruction_lint hook を追加",
            "renderer_ui",
            &members,
        );
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.category == "assign_task_overlap"
                    && f.other_role_id.as_deref() == Some("rust_core")),
            "expected cross-boundary warn pointing to rust_core; got {:?}",
            report.findings
        );
    }

    #[test]
    fn compute_task_overlap_passes_when_aligned() {
        let members = vec![
            member(
                "rust_core",
                "TeamHub protocol の中核",
                "team_hub の recruit / send / assign_task を実装",
            ),
            member(
                "renderer_ui",
                "Canvas UI",
                "components/canvas を担当",
            ),
        ];
        let report = compute_task_overlap(
            "components/canvas の StageHud に warning badge を追加してほしい",
            "renderer_ui",
            &members,
        );
        assert!(
            report.findings.is_empty(),
            "task aligned with target; expected no warn, got {:?}",
            report.findings
        );
    }

    #[test]
    fn compute_task_overlap_short_description_skipped() {
        let members = vec![member("rust_core", "long enough description here", "long enough instructions here")];
        // 7 chars < MIN_CHARS_FOR_TRIGRAMS (8)
        let report = compute_task_overlap("short", "rust_core", &members);
        assert!(report.findings.is_empty());
    }

    #[test]
    fn warn_message_collects_findings() {
        let new = snap(
            "support_helper",
            "Support",
            "なんでもサポートする general 係",
            "support general purpose worker",
        );
        let existing = vec![snap(
            "another_support",
            "Support",
            "general support",
            "general purpose support helper",
        )];
        let report = compute_role_overlap(&new, &existing);
        let msg = report.warn_message("role boundary warnings").unwrap_or_default();
        assert!(msg.contains("vague_keyword") || msg.contains("recruit_role_overlap"));
        assert!(msg.starts_with("role boundary warnings:"));
    }

    #[test]
    fn warn_message_none_when_clean() {
        let new = snap(
            "rust_core",
            "Rust TeamHub Core",
            "vibe-team の TeamHub プロトコル中核",
            "src-tauri/src/team_hub/protocol/ を担当",
        );
        let report = compute_role_overlap(&new, &[]);
        assert!(report.warn_message("role boundary warnings").is_none());
        assert!(report.is_empty());
        assert!(report.finding_strings().is_empty());
    }
}
