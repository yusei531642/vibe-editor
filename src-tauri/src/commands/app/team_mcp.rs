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
            rollback_both(claude_path, claude_snap, codex_path, codex_snap, &mut error_msg).await;
            return Err(anyhow!(error_msg));
        }
    }
    if let Err(e) = crate::mcp_config::codex::setup_at(codex_path, bridge_path).await {
        let mut error_msg = format!("codex mcp setup: {e:#}");
        rollback_both(claude_path, claude_snap, codex_path, codex_snap, &mut error_msg).await;
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
            rollback_both(claude_path, claude_snap, codex_path, codex_snap, &mut error_msg).await;
            return Err(anyhow!(error_msg));
        }
    }
    if let Err(e) = crate::mcp_config::codex::cleanup_at(codex_path).await {
        let mut error_msg = format!("codex mcp cleanup: {e:#}");
        rollback_both(claude_path, claude_snap, codex_path, codex_snap, &mut error_msg).await;
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
        let active =
            crate::state::current_project_root(&state.project_root).unwrap_or_default();
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
    _project_root: String,
    team_id: String,
) -> crate::commands::error::CommandResult<CleanupTeamMcpResult> {
    let last = state.team_hub.clear_team(&team_id).await;
    if !last {
        return Ok(CleanupTeamMcpResult {
            ok: true,
            removed: Some(false),
            error: None,
        });
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

#[cfg(test)]
mod tests {
    //! Issue #597: claude / codex の片肺 rollback を防止する 2-phase シーケンスのテスト。
    //!
    //! `app_setup_team_mcp` 自体は `tauri::State` に依存して unit test しづらいので、
    //! 実体である `run_setup_at` / `run_cleanup_at` を path 引数で叩いて検証する。
    //! 共通の `rollback_both` を使うので、setup の rollback 経路で symmetry が証明できれば
    //! cleanup の rollback も同等に動く (cleanup の失敗注入は OS 依存性が高く不安定なため省略)。

    use super::*;
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::fs;

    /// codex 側 setup を強制失敗させたとき、claude 側も snapshot 状態に戻ること。
    ///
    /// 失敗の作り方: codex_path の親を「regular file」として配置 → atomic_write 内の
    /// `create_dir_all(parent)` が ENOTDIR / AlreadyExists 系で失敗する (POSIX/Windows 共通)。
    /// これは Issue #597 の修正前は claude::restore だけが走り codex 側の半端書き残存を
    /// 招いていた経路。修正後は claude 側も巻き戻る。
    #[tokio::test]
    async fn setup_rolls_back_both_when_codex_setup_fails() {
        let tmp = TempDir::new().unwrap();
        let claude_path = tmp.path().join(".claude.json");
        // 既存 claude content を仕込む (rollback 後にこれが残ることを検証)
        let original_claude = br#"{"existing":true}"#.to_vec();
        fs::write(&claude_path, &original_claude).await.unwrap();

        // codex_path の親を「ファイル」にして codex::setup_at の create_dir_all を確実に失敗させる
        let blocker = tmp.path().join("blocker");
        fs::write(&blocker, b"this is a file, not a directory")
            .await
            .unwrap();
        let codex_path = blocker.join("config.toml");

        let desired = json!({
            "type": "stdio",
            "command": "node",
            "args": ["/tmp/bridge.js"]
        });

        let res = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js").await;
        assert!(res.is_err(), "codex setup should fail when parent is a file");
        let msg = format!("{:#}", res.unwrap_err());
        assert!(
            msg.contains("codex mcp setup"),
            "error should mention codex mcp setup, got: {msg}"
        );

        // claude 側が rollback されているか確認
        let after = fs::read(&claude_path).await.unwrap();
        assert_eq!(
            after, original_claude,
            "claude must be rolled back to original bytes"
        );
        // codex 側はそもそも書けなかったので存在しないこと
        assert!(
            !codex_path.exists(),
            "codex file should not exist after failed setup"
        );
    }

    /// claude 側 setup を強制失敗 (root が array → object check で Err) させたとき、
    /// codex 側の事前 snapshot も restore されること。
    #[tokio::test]
    async fn setup_rolls_back_both_when_claude_setup_fails() {
        let tmp = TempDir::new().unwrap();
        let claude_path = tmp.path().join(".claude.json");
        // claude::setup_at は root が JSON array だと「~/.claude.json must be an object」で Err。
        fs::write(&claude_path, b"[]").await.unwrap();

        let codex_path = tmp.path().join(".codex").join("config.toml");
        // codex に既存 content を入れて、rollback で元に戻ることを検証
        let original_codex = b"[other]\nfoo = 1\n".to_vec();
        fs::create_dir_all(codex_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&codex_path, &original_codex).await.unwrap();

        let desired = json!({ "type": "stdio" });
        let res = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js").await;
        assert!(res.is_err(), "claude setup should fail with array root");
        let msg = format!("{:#}", res.unwrap_err());
        assert!(
            msg.contains("claude mcp setup"),
            "error should mention claude mcp setup, got: {msg}"
        );

        // claude は元のまま (array)
        let claude_after = fs::read(&claude_path).await.unwrap();
        assert_eq!(claude_after, b"[]");
        // codex も rollback で original_codex のまま (claude 失敗時でも codex 側 snapshot は restore される)
        let codex_after = fs::read(&codex_path).await.unwrap();
        assert_eq!(
            codex_after, original_codex,
            "codex must be unchanged / rolled back even when claude side fails first"
        );
    }

    /// 正常系: 両方 setup 成功 → claude には mcpServers.vibe-team が、
    /// codex には [mcp_servers.vibe-team] が入る。
    #[tokio::test]
    async fn setup_writes_both_when_no_failure() {
        let tmp = TempDir::new().unwrap();
        let claude_path = tmp.path().join(".claude.json");
        let codex_path = tmp.path().join(".codex").join("config.toml");

        let desired = json!({
            "type": "stdio",
            "command": "node",
            "args": ["/tmp/bridge.js"]
        });

        let changed = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js")
            .await
            .unwrap();
        assert!(changed, "first setup should report changed=true");

        let claude_str = fs::read_to_string(&claude_path).await.unwrap();
        assert!(
            claude_str.contains("vibe-team"),
            "claude should contain vibe-team entry"
        );
        let codex_str = fs::read_to_string(&codex_path).await.unwrap();
        assert!(
            codex_str.contains("[mcp_servers.vibe-team]"),
            "codex should contain section"
        );
    }

    /// cleanup 正常系: claude / codex 両方から vibe-team 行が消える。
    #[tokio::test]
    async fn cleanup_removes_from_both() {
        let tmp = TempDir::new().unwrap();
        let claude_path = tmp.path().join(".claude.json");
        let original_claude = br#"{
  "mcpServers": {
    "vibe-team": { "command": "node" }
  }
}"#
        .to_vec();
        fs::write(&claude_path, &original_claude).await.unwrap();

        let codex_path = tmp.path().join(".codex").join("config.toml");
        let original_codex =
            b"[other]\nfoo = 1\n\n[mcp_servers.vibe-team]\ncommand = \"node\"\n".to_vec();
        fs::create_dir_all(codex_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&codex_path, &original_codex).await.unwrap();

        let removed = run_cleanup_at(&claude_path, &codex_path).await.unwrap();
        assert!(
            removed,
            "cleanup should report removed=true when claude had vibe-team entry"
        );

        let claude_after = fs::read_to_string(&claude_path).await.unwrap();
        assert!(
            !claude_after.contains("vibe-team"),
            "claude vibe-team entry should be gone"
        );
        let codex_after = fs::read_to_string(&codex_path).await.unwrap();
        assert!(
            !codex_after.contains("[mcp_servers.vibe-team]"),
            "codex section should be gone"
        );
        assert!(
            codex_after.contains("[other]"),
            "codex other sections must be preserved"
        );
    }
}
