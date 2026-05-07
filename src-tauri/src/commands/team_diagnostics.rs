// team_diagnostics.* command — Issue #510.
//
// Renderer (Canvas dashboard / health-check UI) から TeamHub の per-member 診断値を読み出す
// Tauri IPC。元の `team_hub::protocol::tools::diagnostics::team_diagnostics` は MCP socket
// 専用 (agent process が自身の役職で呼ぶ前提) で `Permission::ViewDiagnostics` を中で check
// する。renderer は「Leader が UI から監視している」セマンティクス、つまり Leader 視点の
// 観測なので、Leader 役で `CallContext` を組み立てて同関数を呼ぶ薄い wrapper として実装する。
// Hub 内ロジック (`build_member_diagnostics_row` の row 構築) を 100% 共有することで、
// Issue #524 で追加された PTY 由来 fields (`lastPtyOutputAt` / `autoStale` / `lastPtyActivityAgeMs`
// / `stalenessThresholdMs`) が自動的に renderer 側にも届く。

use crate::state::AppState;
use crate::team_hub::protocol::tools::team_diagnostics;
use crate::team_hub::CallContext;
use serde_json::Value;
use tauri::State;

/// renderer 経由で TeamHub diagnostics を読む。team_id 未登録 / Hub 未起動の場合は
/// `members: []` と等価な「空集計」を返す (UI 側で空状態として描画する)。
///
/// 引数 `team_id` のみ。プロジェクトルートは Hub 内の current state から自動決定される。
/// Permission check は内部で leader 役を impersonate して通過させる ("renderer = Leader が
/// UI から見ている" という semantic を体現)。
#[tauri::command]
pub async fn team_diagnostics_read(
    state: State<'_, AppState>,
    team_id: String,
) -> Result<Value, String> {
    let hub = state.team_hub.clone();
    let ctx = CallContext {
        team_id,
        // Leader 役で impersonate: ViewDiagnostics permission を通すため。
        // 物理シグナル (lastPtyOutputAt / autoStale 等) は agent_id ごとに per-member で
        // 計算されるため、caller 側の agent_id は permission check 以外には影響しない。
        role: "leader".to_string(),
        // 既存 agent と衝突しない synthetic id。pending_inbox_summary の "from_agent_id == self"
        // フィルタで誤って team message を除外しないよう、いずれの agent_id とも被らない名前。
        agent_id: "vibe-editor.renderer".to_string(),
    };
    team_diagnostics(&hub, &ctx).await
}
