// api_agents runtime のユニットテスト (Issue #996)。
//
// 子モジュールなので `api_agents.rs` の private fn (validate_id / sanitize_provider_id /
// session_path / build_skills_context) に直接アクセスできる。可視性を緩めずにテストする。

use super::types::*;
use super::*;

#[test]
fn validate_id_accepts_safe_ids() {
    assert!(validate_id("sessionId", "abc-123_XYZ").is_ok());
    assert!(validate_id("sessionId", "session:gen:card").is_ok());
    // ちょうど 128 文字は許可
    assert!(validate_id("sessionId", &"a".repeat(128)).is_ok());
}

#[test]
fn validate_id_rejects_unsafe_ids() {
    assert!(validate_id("sessionId", "").is_err());
    assert!(validate_id("sessionId", "../etc/passwd").is_err());
    assert!(validate_id("sessionId", "has space").is_err());
    assert!(validate_id("sessionId", "slash/inside").is_err());
    // 129 文字は拒否
    assert!(validate_id("sessionId", &"a".repeat(129)).is_err());
}

#[test]
fn sanitize_provider_id_lowercases_and_rejects_whitespace() {
    // validate_id が trim より前に走るため、空白を含む id は弾かれる。
    assert_eq!(sanitize_provider_id("OpenAI").unwrap(), "openai");
    assert!(sanitize_provider_id("bad id").is_err());
    assert!(sanitize_provider_id("  spaced  ").is_err());
}

#[test]
fn session_path_rejects_traversal_ids() {
    assert!(session_path("../escape").is_err());
    let ok = session_path("safe-session-1").unwrap();
    assert!(ok.ends_with("safe-session-1.json"));
}

#[test]
fn build_skills_context_truncates_to_budget_and_stays_utf8() {
    // MAX_SKILL_BYTES を大きく超えるマルチバイト本文でも panic せず、
    // 出力は valid UTF-8 で概ね予算内に収まる。
    let big = "あ".repeat(MAX_SKILL_BYTES); // 3 bytes/char → 3 * MAX
    let skills = vec![ApiAgentSkill {
        id: "big".to_string(),
        name: "Big".to_string(),
        body: big,
    }];
    let out = build_skills_context(&skills);
    assert!(out.contains("## Skill: Big (big)"));
    // 予算 + ヘッダ + 1 文字分の overshoot 程度に収まる
    assert!(out.len() <= MAX_SKILL_BYTES + 256);
    // char 境界を割らずにスライスできている
    assert!(std::str::from_utf8(out.as_bytes()).is_ok());
}

#[test]
fn build_skills_context_emits_each_selected_skill() {
    let skills = vec![
        ApiAgentSkill {
            id: "a".to_string(),
            name: "Alpha".to_string(),
            body: "alpha-body".to_string(),
        },
        ApiAgentSkill {
            id: "b".to_string(),
            name: "Beta".to_string(),
            body: "beta-body".to_string(),
        },
    ];
    let out = build_skills_context(&skills);
    assert!(out.contains("## Skill: Alpha (a)"));
    assert!(out.contains("alpha-body"));
    assert!(out.contains("## Skill: Beta (b)"));
    assert!(out.contains("beta-body"));
}

#[test]
fn session_round_trips_through_serde_with_camel_case() {
    let session = ApiAgentSession {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "s1".to_string(),
        agent_id: "agent-1".to_string(),
        provider_id: "openai".to_string(),
        model: "gpt-4.1".to_string(),
        title: Some("Chat".to_string()),
        created_at: "2026-06-14T00:00:00Z".to_string(),
        updated_at: "2026-06-14T00:01:00Z".to_string(),
        messages: vec![ApiAgentMessage {
            id: "m1".to_string(),
            role: "user".to_string(),
            content: "hi".to_string(),
            created_at: "2026-06-14T00:00:30Z".to_string(),
            tool_name: None,
        }],
        turn_logs: vec![ApiAgentTurnLog {
            generation_id: "g1".to_string(),
            chain_id: Some("c1".to_string()),
            depth: 0,
            turn_number: 1,
            stop_reason: "stop".to_string(),
            usage: Some(ApiAgentUsage {
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: Some(15),
            }),
            created_at: "2026-06-14T00:01:00Z".to_string(),
        }],
        tool_mode: "auto".to_string(),
    };
    let json = serde_json::to_value(&session).unwrap();
    // camelCase で serialize される
    assert_eq!(
        json["schemaVersion"],
        serde_json::json!(SESSION_SCHEMA_VERSION)
    );
    assert_eq!(json["sessionId"], serde_json::json!("s1"));
    assert_eq!(json["turnLogs"][0]["generationId"], serde_json::json!("g1"));
    assert_eq!(json["toolMode"], serde_json::json!("auto"));
    // round-trip で等価
    let back: ApiAgentSession = serde_json::from_value(json).unwrap();
    assert_eq!(back.session_id, session.session_id);
    assert_eq!(back.messages.len(), 1);
    assert_eq!(
        back.turn_logs[0].usage.as_ref().unwrap().total_tokens,
        Some(15)
    );
}
