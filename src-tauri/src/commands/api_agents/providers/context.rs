// providers/context — 会話履歴の char バジェットによるトリミング (Issue #1057)。
//
// 長い会話が provider の context window を超えてリクエスト失敗するのを防ぐため、送信前に
// 末尾 (最新) 優先で履歴を切り詰める。token 数の厳密計算はせず char 数を近似プロキシに使う
// (Codex の auto-compaction の簡易版)。system prompt は messages とは別経路なので対象外。

use super::super::types::ApiAgentMessage;

/// 既定の char バジェット (~50k tokens 目安)。
const DEFAULT_MAX_CHARS: usize = 200_000;

/// 既定バジェットで履歴をトリミングする。
pub(super) fn default_trim(messages: &[ApiAgentMessage]) -> Vec<ApiAgentMessage> {
    trim_messages(messages, DEFAULT_MAX_CHARS)
}

/// 末尾 (最新) から `max_chars` に収まる連続スライスを返す。最低でも最後の 1 件は残す
/// (最後の 1 件が単体で超過していてもそれは保持する — それ以上は縮められないため)。
pub(super) fn trim_messages(
    messages: &[ApiAgentMessage],
    max_chars: usize,
) -> Vec<ApiAgentMessage> {
    if messages.is_empty() {
        return Vec::new();
    }
    // 最後の 1 件は必ず含める。
    let mut start = messages.len() - 1;
    let mut total = messages[start].content.len();
    // そこから古い方へ、バジェットに収まる限り取り込む。
    while start > 0 {
        let prev = start - 1;
        let len = messages[prev].content.len();
        if total + len > max_chars {
            break;
        }
        total += len;
        start = prev;
    }
    messages[start..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ApiAgentMessage {
        ApiAgentMessage {
            id: format!("{role}-{}", content.len()),
            role: role.to_string(),
            content: content.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            tool_name: None,
        }
    }

    #[test]
    fn keeps_all_when_under_budget() {
        let ms = vec![msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
        let out = trim_messages(&ms, 1000);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn drops_oldest_when_over_budget() {
        // 各 10 chars、budget 25 → 末尾から 2 件 (20) は入るが 3 件目 (30) は超過。
        let ms = vec![
            msg("user", &"x".repeat(10)),
            msg("assistant", &"y".repeat(10)),
            msg("user", &"z".repeat(10)),
        ];
        let out = trim_messages(&ms, 25);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].content, "y".repeat(10));
        assert_eq!(out[1].content, "z".repeat(10));
    }

    #[test]
    fn always_keeps_last_even_if_over_budget() {
        let ms = vec![msg("user", "old"), msg("user", &"big".repeat(100))];
        let out = trim_messages(&ms, 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "big".repeat(100));
    }

    #[test]
    fn empty_returns_empty() {
        assert!(trim_messages(&[], 100).is_empty());
    }

    #[test]
    fn default_trim_keeps_small_history() {
        let ms = vec![msg("user", "hi"), msg("assistant", "hello")];
        assert_eq!(default_trim(&ms).len(), 2);
    }
}
