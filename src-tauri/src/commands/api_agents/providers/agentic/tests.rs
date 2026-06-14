// providers/agentic のユニットテスト (Issue #1002 / #1004)。
// 親 agentic.rs の private fn / 型に `use super::*` でアクセスする。

use super::*;

#[test]
    fn openai_extract_parses_tool_calls() {
        let msg = json!({
            "content": null,
            "tool_calls": [
                { "id": "call_1", "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" } }
            ]
        });
        let (text, calls) = openai_extract(&msg);
        assert_eq!(text, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].args["path"], json!("a.txt"));
    }

    #[test]
    fn openai_extract_final_text_has_no_calls() {
        let msg = json!({ "content": "here is the answer" });
        let (text, calls) = openai_extract(&msg);
        assert_eq!(text, "here is the answer");
        assert!(calls.is_empty());
    }

    #[test]
    fn anthropic_extract_separates_text_and_tool_use() {
        let content = vec![
            json!({ "type": "text", "text": "let me check " }),
            json!({ "type": "tool_use", "id": "tu_1", "name": "list_dir", "input": { "path": "." } }),
        ];
        let (text, calls) = anthropic_extract(&content);
        assert_eq!(text, "let me check ");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "list_dir");
        assert_eq!(calls[0].id, "tu_1");
        assert_eq!(calls[0].args["path"], json!("."));
    }

    #[test]
    fn gemini_extract_reads_function_call() {
        let parts = vec![
            json!({ "text": "checking" }),
            json!({ "functionCall": { "name": "read_file", "args": { "path": "x.rs" } } }),
        ];
        let (text, calls) = gemini_extract(&parts);
        assert_eq!(text, "checking");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].args["path"], json!("x.rs"));
        assert!(calls[0].id.is_empty());
    }

    #[test]
    fn accumulate_usage_sums_across_turns() {
        let mut total = None;
        accumulate_usage(
            &mut total,
            Some(ApiAgentUsage {
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: None,
            }),
        );
        accumulate_usage(
            &mut total,
            Some(ApiAgentUsage {
                input_tokens: Some(7),
                output_tokens: Some(3),
                total_tokens: Some(20),
            }),
        );
        let u = total.unwrap();
        assert_eq!(u.input_tokens, Some(17));
        assert_eq!(u.output_tokens, Some(8));
        assert_eq!(u.total_tokens, Some(20));
    }

    #[test]
    fn summarize_args_truncates_long_payloads() {
        let big = json!({ "path": "a".repeat(300) });
        let s = summarize_args(&big);
        assert!(s.chars().count() <= 121);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn tool_specs_adds_team_tools_only_when_in_a_team() {
        use crate::pty::SessionRegistry;
        use crate::team_hub::TeamHub;
        use std::sync::Arc;

        let mut noop = |_: &str, _: &str, _: Option<&str>| {};
        // team 無し: read_file / list_dir のみ
        let rt_solo = ToolRuntime {
            project_root: "",
            max_turns: 1,
            on_tool: &mut noop,
            team: None,
        };
        let solo: Vec<&str> = tool_specs(&rt_solo).iter().map(|s| s.name).collect();
        assert_eq!(solo, vec!["read_file", "list_dir"]);

        // team 有り: team_read / team_send / team_info が追加される
        let mut noop2 = |_: &str, _: &str, _: Option<&str>| {};
        let rt_team = ToolRuntime {
            project_root: "",
            max_turns: 1,
            on_tool: &mut noop2,
            team: Some(TeamToolCtx {
                hub: TeamHub::new(Arc::new(SessionRegistry::new())),
                team_id: "team-1".into(),
                agent_id: "api-1".into(),
                role: "reviewer".into(),
            }),
        };
        let team: Vec<&str> = tool_specs(&rt_team).iter().map(|s| s.name).collect();
        assert!(team.contains(&"read_file"));
        assert!(team.contains(&"team_read"));
        assert!(team.contains(&"team_send"));
        assert!(team.contains(&"team_info"));
    }
