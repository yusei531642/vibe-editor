use crate::state::AppState;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupTeamMcpResult {
    pub ok: bool,
    pub error: Option<String>,
    pub socket: Option<String>,
    pub changed: Option<bool>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTeamMcpResult {
    pub ok: bool,
    pub error: Option<String>,
    pub removed: Option<bool>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLeaderResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamHubInfo {
    pub socket: String,
    pub token: String,
    pub bridge_path: String,
}

// Issue #336 / #800: `agent_id` と `role` は register_team の binding seed に使う。
// `agent` フィールドは現状未参照だが、renderer から `app_setup_team_mcp` に渡される
// 情報のシグネチャを保つため保持する (将来 MCP 設定生成や telemetry で読み出しを再開する想定)。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMcpMember {
    pub agent_id: String,
    pub role: String,
    #[allow(dead_code)]
    pub agent: String,
}

/// Issue #597: claude / codex のどちらか片方だけが書き換わった「半端状態」を絶対に残さない。
///
/// シーケンス:
///   1. claude / codex 両方の現状を pre-snapshot (片肺ではダメ)
///   2. claude::setup → 失敗時は両方 restore
///   3. codex::setup → 失敗時は両方 restore (`~/.claude.json` を rollback しないと
///      legacy/現行 entry が片方だけ残る不整合が永続化する)
///
/// 戻り値は claude::setup_at が変更を生んだかどうか (changed)。
async fn run_setup_at(
    claude_path: &Path,
    codex_path: &Path,
    desired: &serde_json::Value,
    bridge_path: &str,
) -> Result<bool> {
    let claude_snap = crate::mcp_config::claude::snapshot_at(claude_path)
        .await
        .map_err(|e| anyhow!("claude mcp snapshot: {e:#}"))?;
    let codex_snap = crate::mcp_config::codex::snapshot_at(codex_path)
        .await
        .map_err(|e| anyhow!("codex mcp snapshot: {e:#}"))?;

    let mut changed = false;
    match crate::mcp_config::claude::setup_at(claude_path, desired).await {
        Ok(c) => changed |= c,
        Err(e) => {
            let mut error_msg = format!("claude mcp setup: {e:#}");
            rollback_both(
                claude_path,
                claude_snap,
                codex_path,
                codex_snap,
                &mut error_msg,
            )
            .await;
            return Err(anyhow!(error_msg));
        }
    }
    if let Err(e) = crate::mcp_config::codex::setup_at(codex_path, bridge_path).await {
        let mut error_msg = format!("codex mcp setup: {e:#}");
        rollback_both(
            claude_path,
            claude_snap,
            codex_path,
            codex_snap,
            &mut error_msg,
        )
        .await;
        return Err(anyhow!(error_msg));
    }
    Ok(changed)
}

/// Issue #597: cleanup_team_mcp も対称な 2-phase rollback。setup と同じ rollback_both を共有。
async fn run_cleanup_at(claude_path: &Path, codex_path: &Path) -> Result<bool> {
    let claude_snap = crate::mcp_config::claude::snapshot_at(claude_path)
        .await
        .map_err(|e| anyhow!("claude mcp snapshot: {e:#}"))?;
    let codex_snap = crate::mcp_config::codex::snapshot_at(codex_path)
        .await
        .map_err(|e| anyhow!("codex mcp snapshot: {e:#}"))?;

    let mut removed = false;
    match crate::mcp_config::claude::cleanup_at(claude_path).await {
        Ok(r) => removed |= r,
        Err(e) => {
            let mut error_msg = format!("claude mcp cleanup: {e:#}");
            rollback_both(
                claude_path,
                claude_snap,
                codex_path,
                codex_snap,
                &mut error_msg,
            )
            .await;
            return Err(anyhow!(error_msg));
        }
    }
    if let Err(e) = crate::mcp_config::codex::cleanup_at(codex_path).await {
        let mut error_msg = format!("codex mcp cleanup: {e:#}");
        rollback_both(
            claude_path,
            claude_snap,
            codex_path,
            codex_snap,
            &mut error_msg,
        )
        .await;
        return Err(anyhow!(error_msg));
    }
    Ok(removed)
}

/// claude / codex の snapshot を両方 restore。失敗はログに残し、ユーザー向け error_msg にも追記する
/// (片方だけ rollback 成功 / 失敗の組み合わせをユーザーが手動で確認できるよう、明示的に書く)。
async fn rollback_both(
    claude_path: &Path,
    claude_snap: Option<Vec<u8>>,
    codex_path: &Path,
    codex_snap: Option<Vec<u8>>,
    error_msg: &mut String,
) {
    if let Err(re) = crate::mcp_config::claude::restore_at(claude_path, claude_snap).await {
        tracing::error!("[mcp] claude rollback failed: {re:#}");
        *error_msg = format!(
            "{error_msg} (rollback claude also failed: {re:#}; please review ~/.claude.json manually)"
        );
    } else {
        tracing::warn!("[mcp] claude rolled back to previous snapshot");
    }
    if let Err(re) = crate::mcp_config::codex::restore_at(codex_path, codex_snap).await {
        tracing::error!("[mcp] codex rollback failed: {re:#}");
        *error_msg = format!(
            "{error_msg} (rollback codex also failed: {re:#}; please review ~/.codex/config.toml manually)"
        );
    } else {
        tracing::warn!("[mcp] codex rolled back to previous snapshot");
    }
}

#[tauri::command]
pub async fn app_setup_team_mcp(
    state: State<'_, AppState>,
    project_root: String,
    team_id: String,
    team_name: String,
    members: Vec<TeamMcpMember>,
) -> crate::commands::error::CommandResult<SetupTeamMcpResult> {
    // Issue #1193: TeamHub登録・MCP設定・inbox watcher はすべて副作用である。renderer由来の
    // rootを先に登録してから認可する旧順序では、foreign rootが永続stateへ残った。
    // 最初にnative authority付きactive rootを解決し、失敗時は副作用を一切起こさない。
    let authorized_root = match crate::commands::authz::assert_active_project_root(
        &state.project_root,
        &state.project_root_identity,
        &project_root,
    )
    .await
    {
        Ok(root) => root.as_str().to_string(),
        Err(error) => {
            return Ok(SetupTeamMcpResult {
                ok: false,
                error: Some(format!("project root authorization failed: {error}")),
                ..Default::default()
            });
        }
    };
    let hub = state.team_hub.clone();
    // 念のため Hub を起動 (setup でも spawn 済み)
    if let Err(e) = hub.start().await {
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(format!("teamhub start failed: {e:#}")),
            ..Default::default()
        });
    }
    // Issue #800: Canvas spawn 由来の初代 leader / worker は recruit grant 経路を
    // 通らないため、team setup 時に member の (agent_id, role) を binding として
    // 事前 seed する。これにより handshake (resolve_pending_recruit) が既存 binding
    // 経路でこれらを許可する。
    let member_bindings: Vec<(String, String)> = members
        .iter()
        .map(|m| (m.agent_id.clone(), m.role.clone()))
        .collect();
    if let Err(error) = hub
        .register_team(
            &team_id,
            &team_name,
            Some(&authorized_root),
            &member_bindings,
        )
        .await
    {
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(error),
            ..Default::default()
        });
    }

    // vibe-team Skill ファイルを best-effort で配置/同期する。
    // setupTeamMcp は「_init」ウォームアップ呼び出しでも、実チーム起動でも、復元呼び出しでも走る。
    // どのケースでも install_skill_best_effort はバージョンヘッダで idempotent (内容一致なら no-op、
    // 同バージョンヘッダで内容差分があれば自動上書き、ヘッダ無しのユーザー編集ファイルには触らない)
    // なので team_id を問わず常に呼んでよい。アプリ起動毎に最新の SKILL.md が確実に同期される。
    //
    crate::commands::vibe_team_skill::install_skill_best_effort(&authorized_root).await;
    let (socket, token, bridge_path) = hub.info().await;
    let inbox_watch_path = crate::team_hub::inbox_watch::path_from_bridge(&bridge_path);
    if let Err(e) =
        crate::mcp_config::claude::setup_project_inbox_hook(&authorized_root, &inbox_watch_path)
            .await
    {
        tracing::warn!("[setup_team_mcp] inbox monitor hook setup failed: {e:#}");
    }
    let desired = crate::mcp_config::bridge_desired(&socket, &token, &bridge_path);

    // Issue #597: claude / codex の片肺 rollback を防止。両方 pre-snapshot → 失敗時両方 restore。
    let claude_path = crate::mcp_config::claude::config_path();
    let codex_path = crate::mcp_config::codex::config_path();
    match run_setup_at(&claude_path, &codex_path, &desired, &bridge_path).await {
        Ok(changed) => Ok(SetupTeamMcpResult {
            ok: true,
            socket: Some(socket),
            changed: Some(changed),
            error: None,
        }),
        Err(e) => Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(format!("{e:#}")),
            ..Default::default()
        }),
    }
}

#[tauri::command]
pub async fn app_cleanup_team_mcp(
    state: State<'_, AppState>,
    project_root: String,
    team_id: String,
) -> crate::commands::error::CommandResult<CleanupTeamMcpResult> {
    // Issue #1193: cleanupもHub state / PTY / MCP設定を変更する副作用であるため、clearより先に
    // active-root authorityを確認する。foreign root指定で他projectのteamを消せてはならない。
    let authorized_root = match crate::commands::authz::assert_active_project_root(
        &state.project_root,
        &state.project_root_identity,
        &project_root,
    )
    .await
    {
        Ok(root) => root.as_str().to_string(),
        Err(error) => {
            return Ok(CleanupTeamMcpResult {
                ok: false,
                error: Some(format!("project root authorization failed: {error}")),
                removed: None,
            });
        }
    };
    let last = match state
        .team_hub
        .clear_team_for_project(&team_id, &authorized_root)
        .await
    {
        Ok(last) => last,
        Err(error) => {
            return Ok(CleanupTeamMcpResult {
                ok: false,
                error: Some(error),
                removed: None,
            });
        }
    };

    // Issue #937: 従来は hub state / MCP 設定だけを消し PTY registry に触れていなかったため、
    // チームの PTY (と claude CLI が spawn した MCP node 群) は renderer の React unmount kill
    // 一極依存で、UI フリーズ/クラッシュ時に孤児化していた (#864 / #829)。チーム解散の所有者で
    // ある本コマンドが backend 側でも team スコープの PTY を確実に回収する (残チーム数に依らず実行)。
    let reclaimed = state.pty_registry.kill_team(&team_id);
    if reclaimed > 0 {
        tracing::info!(
            "[cleanup_team_mcp] reclaimed {reclaimed} PTY session(s) for team {team_id}"
        );
    }

    if !last {
        return Ok(CleanupTeamMcpResult {
            ok: true,
            removed: Some(false),
            error: None,
        });
    }
    if let Err(e) = crate::mcp_config::claude::cleanup_project_inbox_hook(&authorized_root).await {
        tracing::warn!("[cleanup_team_mcp] inbox monitor hook cleanup failed: {e:#}");
    }

    // Issue #597: 残りアクティブチームが 0 になったら MCP 設定を削除。
    // claude / codex の片肺 rollback を防止 — 両方 pre-snapshot → 失敗時両方 restore。
    let claude_path = crate::mcp_config::claude::config_path();
    let codex_path = crate::mcp_config::codex::config_path();
    match run_cleanup_at(&claude_path, &codex_path).await {
        Ok(removed) => Ok(CleanupTeamMcpResult {
            ok: true,
            removed: Some(removed),
            error: None,
        }),
        Err(e) => Ok(CleanupTeamMcpResult {
            ok: false,
            error: Some(format!("{e:#}")),
            removed: None,
        }),
    }
}

#[tauri::command]
pub async fn app_set_active_leader(
    state: State<'_, AppState>,
    team_id: String,
    agent_id: Option<String>,
) -> crate::commands::error::CommandResult<ActiveLeaderResult> {
    if team_id.trim().is_empty() {
        return Ok(ActiveLeaderResult {
            ok: false,
            error: Some("teamId is required".into()),
        });
    }
    let Some(active_root) = crate::state::current_project_root(&state.project_root) else {
        return Ok(ActiveLeaderResult {
            ok: false,
            error: Some("active project root is not set".into()),
        });
    };
    let authorized_root = match crate::commands::authz::assert_active_project_root(
        &state.project_root,
        &state.project_root_identity,
        &active_root,
    )
    .await
    {
        Ok(root) => root.as_str().to_string(),
        Err(error) => {
            return Ok(ActiveLeaderResult {
                ok: false,
                error: Some(format!("project root authorization failed: {error}")),
            });
        }
    };
    if let Err(error) = state
        .team_hub
        .set_active_leader_for_project(&team_id, &authorized_root, agent_id)
        .await
    {
        return Ok(ActiveLeaderResult {
            ok: false,
            error: Some(error),
        });
    }
    Ok(ActiveLeaderResult {
        ok: true,
        error: None,
    })
}

#[tauri::command]
pub fn app_get_team_file_path(team_id: String) -> String {
    crate::util::config_paths::vibe_root()
        .join(format!("team-{team_id}.json"))
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub async fn app_get_mcp_server_path(
    state: State<'_, AppState>,
) -> crate::commands::error::CommandResult<String> {
    let (_, _, bridge_path) = state.team_hub.info().await;
    Ok(bridge_path)
}

#[tauri::command]
pub async fn app_get_team_hub_info(
    state: State<'_, AppState>,
) -> crate::commands::error::CommandResult<TeamHubInfo> {
    let (socket, token, bridge_path) = state.team_hub.info().await;
    Ok(TeamHubInfo {
        socket,
        token,
        bridge_path,
    })
}

/// renderer 側で構築した role profile summary を TeamHub に同期する。
/// MCP の team_list_role_profiles と permissions 検証で参照される。
#[tauri::command]
pub async fn app_set_role_profile_summary(
    state: State<'_, AppState>,
    summary: Vec<crate::team_hub::RoleProfileSummary>,
) -> crate::commands::error::CommandResult<()> {
    state.team_hub.set_role_profile_summary(summary).await;
    Ok(())
}

/// recruit 完了時 / cancel 時に renderer から呼ぶ。
/// 主に手動 cancel (ユーザーがカードを × で閉じた等) に使う。
#[tauri::command]
pub async fn app_cancel_recruit(
    state: State<'_, AppState>,
    agent_id: String,
) -> crate::commands::error::CommandResult<()> {
    state.team_hub.cancel_pending_recruit(&agent_id).await;
    Ok(())
}

/// Issue #342 Phase 1: renderer から `team:recruit-request` を受領 / spawn 結果を通知するための ack 経路。
///
/// renderer が `team:recruit-request` event を受けて addCard / spawn を開始した時点で
/// `ok=true` を打つ。spawn 失敗 / requester 不在等で起動できなかった場合は `ok=false`
/// + `phase` (`spawn` / `engine_binary_missing` / `instructions_load` / `requester_not_found`)
/// + 任意 `reason` を打つ。
///
/// 設計原則:
///   - **flat 引数**: 既存 `app_cancel_recruit(agent_id)` の流儀に揃える (renderer 側合意)
///   - **ack の意味は受領通知のみ**: `ok=true` でも MCP `team_recruit` の戻り値はまだ成功にしない。
///     真の成功判定は handshake 経路 (`resolve_pending_recruit`) のみ。renderer 信頼境界違反で
///     偽 `ok=true` を打たれても MCP caller は騙されない。
///   - **入力サニタイズ (Reviewer D Critical 反映)**:
///       - `phase` は enum ホワイトリスト 4 値に制限 (任意文字列を log injection に使われないように)
///       - `reason` は 256 byte 上限で truncate (DoS 抑止)
///   - **認可ガード**: pending 不在 / team_id 不一致 / 重複 ack はすべて Hub 側で no-op + warn ログ。
///     呼び出し側 (renderer) には `Ok(())` を返してエラー観測点を作らない (偽装試行を区別不能にする)。
#[tauri::command]
pub async fn app_recruit_ack(
    state: State<'_, AppState>,
    new_agent_id: String,
    team_id: String,
    ok: bool,
    reason: Option<String>,
    phase: Option<String>,
) -> crate::commands::error::CommandResult<()> {
    use crate::team_hub::error::AckFailPhase;
    use crate::team_hub::RecruitAckOutcome;

    /// renderer 側 reason 文字列の最大長 (UTF-8 byte 数)。これを超えたら byte 単位で切り詰める。
    /// 文字境界をまたぐと char_indices で見つかる手前位置に丸める。
    const MAX_REASON_BYTES: usize = 256;

    fn truncate_reason(s: String) -> String {
        if s.len() <= MAX_REASON_BYTES {
            return s;
        }
        // UTF-8 boundary を尊重して切り詰め
        let mut cut = MAX_REASON_BYTES;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut out = s;
        out.truncate(cut);
        out
    }

    // phase 文字列を enum に正規化。未知値は ok=false 時のみ問題なので、
    // None に丸めて後続ロジックは「不明な失敗」として扱う。
    let phase_enum = phase.as_deref().and_then(AckFailPhase::from_str);
    if !ok && phase.is_some() && phase_enum.is_none() {
        tracing::warn!(
            "[teamhub] recruit_ack rejected unknown phase value: {:?} (agent={new_agent_id})",
            phase
        );
        // 未知 phase は無視せず、no-op で握り潰す代わりに pending を cancel して
        // ユーザーをロックさせない (この経路は renderer のバグか改ざんなので cancel が安全側)
        state.team_hub.cancel_pending_recruit(&new_agent_id).await;
        return Ok(());
    }

    let outcome = RecruitAckOutcome {
        ok,
        reason: reason.map(truncate_reason),
        phase: phase_enum,
    };

    // 認可ガードは Hub 側で完結。エラーは呼び出し元には返さず、内部診断ログのみ。
    let _ = state
        .team_hub
        .resolve_recruit_ack(&new_agent_id, &team_id, outcome)
        .await;
    Ok(())
}

#[cfg(test)]
#[path = "team_mcp/tests.rs"]
mod tests;
