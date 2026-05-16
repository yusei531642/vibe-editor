//! tool: `team_info` — return current team roster + caller's identity.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};
use std::collections::HashMap;

use super::error::ToolError;

pub async fn team_info(hub: &TeamHub, ctx: &CallContext) -> Result<Value, ToolError> {
    // Issue #342 Phase 2: identity 分離検出のため `agent_role_bindings` を一緒に取る。
    // member の registry 上 role と handshake 時に bind した role が乖離している (= 別
    // プロセスが同 agent_id で違う role を主張した / context が古い) なら
    // `inconsistent: true` を返す。`bindingTeamId` 等の cross-member 機微情報は伏字化し、
    // 自分自身の binding (`myBoundRole`) のみフル表示する。
    // Issue #518: チーム単位の engine_policy を一緒に取得して response に乗せる。
    // HR / Leader / UI が「自分が属する team は ClaudeOnly か?」を確認するために必要。
    // Issue #637: `agent_role_bindings` は `(team_id, agent_id)` キーになっているので、
    // 当該 team_id のスコープだけを抽出した `agent_id -> role` マップに reduce してから
    // 既存の inconsistent 判定ロジックを適用する (cross-team の他 team binding は無視)。
    let state = hub.state.lock().await;
    let team_entry = state.teams.get(&ctx.team_id);
    let name = team_entry.map(|t| t.name.clone()).unwrap_or_default();
    let engine_policy = team_entry.map(|t| t.engine_policy.clone()).unwrap_or_default();
    let bindings_snapshot: HashMap<String, String> = state
        .agent_role_bindings
        .iter()
        .filter(|((team_id, _), _)| team_id == &ctx.team_id)
        .map(|((_, agent_id), role)| (agent_id.clone(), role.clone()))
        .collect();
    drop(state);
    let members: Vec<_> = hub
        .registry
        .list_team_members(&ctx.team_id)
        .into_iter()
        .map(|(aid, role)| {
            // role 比較は case-insensitive (resolve_targets と同じ流儀)。
            // bind 未登録 (handshake 未完など) の member は inconsistent=false 扱い
            // (まだ bind 機会が無いだけで矛盾とは言えないため)。
            let inconsistent = match bindings_snapshot.get(&aid) {
                Some(bound) => !bound.eq_ignore_ascii_case(&role),
                None => false,
            };
            json!({
                "role": role,
                "agentId": aid,
                "online": true,
                "inconsistent": inconsistent,
            })
        })
        .collect();
    let my_bound_role = bindings_snapshot.get(&ctx.agent_id).cloned();
    Ok(json!({
        "teamId": ctx.team_id,
        "teamName": name,
        "myRole": ctx.role,
        "myAgentId": ctx.agent_id,
        "myBoundRole": my_bound_role,
        "members": members,
        "enginePolicy": engine_policy,
    }))
}
