use crate::state::AppState;
use serde::Serialize;
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

// Issue #336: 全フィールドが現状未参照だが、renderer から `app_setup_team_mcp` に
// 渡される情報のシグネチャを保つため struct ごと保持する。将来 MCP 設定生成や
// telemetry で読み出しを再開する想定。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct TeamMcpMember {
    pub agent_id: String,
    pub role: String,
    pub agent: String,
}

#[tauri::command]
pub async fn app_setup_team_mcp(
    state: State<'_, AppState>,
    project_root: String,
    team_id: String,
    team_name: String,
    _members: Vec<TeamMcpMember>,
) -> crate::commands::error::CommandResult<SetupTeamMcpResult> {
    let hub = state.team_hub.clone();
    // 念のため Hub を起動 (setup でも spawn 済み)
    if let Err(e) = hub.start().await {
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(format!("teamhub start failed: {e:#}")),
            ..Default::default()
        });
    }
    hub.register_team(&team_id, &team_name, Some(&project_root))
        .await;

    // vibe-team Skill ファイルを best-effort で配置/同期する。
    // setupTeamMcp は「_init」ウォームアップ呼び出しでも、実チーム起動でも、復元呼び出しでも走る。
    // どのケースでも install_skill_best_effort はバージョンヘッダで idempotent (内容一致なら no-op、
    // 同バージョンヘッダで内容差分があれば自動上書き、ヘッダ無しのユーザー編集ファイルには触らない)
    // なので team_id を問わず常に呼んでよい。アプリ起動毎に最新の SKILL.md が確実に同期される。
    //
    // Issue #191 (Security): 旧実装は renderer 由来の project_root をそのまま install に流して
    // いたため、改ざん済み bundled JS から任意ディレクトリ配下に SKILL.md を plant 可能だった
    // (#135 で app_install_vibe_team_skill だけに付けたガードが、setup 経路では空転していた)。
    // → app_install_vibe_team_skill と同じく req_canon == active_canon を検証してから install する。
    let trimmed = project_root.trim();
    if !trimmed.is_empty() {
        let active = crate::state::lock_project_root_recover(&state.project_root)
            .clone()
            .unwrap_or_default();
        if active.trim().is_empty() {
            tracing::warn!(
                "[setup_team_mcp] skipping skill install: no active project_root configured"
            );
        } else {
            // canonicalize は async fn 内では tokio::fs を使う (network mount 等で blocking I/O が
            // Tokio worker を塞ぐのを避けるため)。req と active は独立なので join で並列実行。
            let (req_res, active_res) = tokio::join!(
                tokio::fs::canonicalize(trimmed),
                tokio::fs::canonicalize(active.trim())
            );
            match (req_res, active_res) {
                (Ok(req_canon), Ok(active_canon)) if req_canon == active_canon => {
                    crate::commands::vibe_team_skill::install_skill_best_effort(
                        &req_canon.to_string_lossy(),
                    )
                    .await;
                }
                (Ok(req_canon), Ok(active_canon)) => {
                    tracing::warn!(
                        "[setup_team_mcp] skill install denied: requested {} != active {}",
                        req_canon.display(),
                        active_canon.display()
                    );
                }
                (req_res, active_res) => {
                    // どちらか / 両方失敗。両方分けて出すことで「片方だけ失敗 → ディスク破損疑い」
                    // 「両方失敗 → 設定経路の不整合」のデバッグ材料を残す。
                    if let Err(e) = req_res {
                        tracing::warn!(
                            "[setup_team_mcp] canonicalize requested project_root failed: {e}"
                        );
                    }
                    if let Err(e) = active_res {
                        tracing::warn!(
                            "[setup_team_mcp] canonicalize active project_root failed: {e}"
                        );
                    }
                }
            }
        }
    }
    let (socket, token, bridge_path) = hub.info().await;
    let desired = crate::mcp_config::bridge_desired(&socket, &token, &bridge_path);

    // Issue #118: claude / codex のどちらか片方だけが書き換わった「半端状態」を残さない。
    // 事前にスナップショットを取り、claude→codex の順に書く。codex で失敗したら claude を rollback。
    let claude_snap = match crate::mcp_config::claude::snapshot().await {
        Ok(s) => s,
        Err(e) => {
            return Ok(SetupTeamMcpResult {
                ok: false,
                error: Some(format!("claude mcp snapshot: {e:#}")),
                ..Default::default()
            });
        }
    };

    let mut changed = false;
    match crate::mcp_config::claude::setup(&desired).await {
        Ok(c) => changed |= c,
        Err(e) => {
            return Ok(SetupTeamMcpResult {
                ok: false,
                error: Some(format!("claude mcp setup: {e:#}")),
                ..Default::default()
            })
        }
    }
    if let Err(e) = crate::mcp_config::codex::setup(&bridge_path).await {
        // claude 側を元に戻す。rollback 自体が失敗した場合はログに残し、ユーザーには両方
        // 失敗したことを返す (ユーザーが手動で `~/.claude.json` を確認できるようメッセージで促す)。
        let mut error_msg = format!("codex mcp setup: {e:#}");
        if let Err(re) = crate::mcp_config::claude::restore(claude_snap).await {
            tracing::error!("[mcp] claude rollback failed after codex setup error: {re:#}");
            error_msg = format!(
                "{error_msg} (rollback claude also failed: {re:#}; please review ~/.claude.json manually)"
            );
        } else {
            tracing::warn!("[mcp] codex setup failed, claude rolled back to previous state");
        }
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(error_msg),
            ..Default::default()
        });
    }
    Ok(SetupTeamMcpResult {
        ok: true,
        socket: Some(socket),
        changed: Some(changed),
        error: None,
    })
}

#[tauri::command]
pub async fn app_cleanup_team_mcp(
    state: State<'_, AppState>,
    _project_root: String,
    team_id: String,
) -> crate::commands::error::CommandResult<CleanupTeamMcpResult> {
    let last = state.team_hub.clear_team(&team_id).await;
    let mut removed = false;
    if last {
        // Issue #118: 片側だけ vibe-team 行が消えた半端状態を残さない。
        // 事前にスナップショットを取り、codex 側で失敗したら claude を元に戻す。
        let claude_snap = match crate::mcp_config::claude::snapshot().await {
            Ok(s) => s,
            Err(e) => {
                return Ok(CleanupTeamMcpResult {
                    ok: false,
                    error: Some(format!("claude mcp snapshot: {e:#}")),
                    removed: None,
                });
            }
        };

        // 残りアクティブチームが 0 になったら MCP 設定を削除
        match crate::mcp_config::claude::cleanup().await {
            Ok(r) => removed |= r,
            Err(e) => {
                return Ok(CleanupTeamMcpResult {
                    ok: false,
                    error: Some(format!("claude mcp cleanup: {e:#}")),
                    removed: None,
                })
            }
        }
        if let Err(e) = crate::mcp_config::codex::cleanup().await {
            let mut error_msg = format!("codex mcp cleanup: {e:#}");
            if let Err(re) = crate::mcp_config::claude::restore(claude_snap).await {
                tracing::error!("[mcp] claude rollback failed after codex cleanup error: {re:#}");
                error_msg = format!(
                    "{error_msg} (rollback claude also failed: {re:#}; please review ~/.claude.json manually)"
                );
            } else {
                tracing::warn!("[mcp] codex cleanup failed, claude restored to previous state");
            }
            return Ok(CleanupTeamMcpResult {
                ok: false,
                error: Some(error_msg),
                removed: None,
            });
        }
    }
    Ok(CleanupTeamMcpResult {
        ok: true,
        removed: Some(removed),
        error: None,
    })
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
    state.team_hub.set_active_leader(&team_id, agent_id).await;
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
