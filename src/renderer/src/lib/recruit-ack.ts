/**
 * recruit-ack — Issue #342 Phase 1
 *
 * `team:recruit-request` event を受領した renderer 側が、Tauri Hub に
 * 「受領通知 / 失敗通知」を返すための薄いヘルパ。
 *
 * Hub 側 (`team_recruit` MCP) は emit 後に `RECRUIT_ACK_TIMEOUT=5s` で本 invoke を
 * 待機する。renderer は次のいずれかで `app_recruit_ack` を呼ぶ:
 *
 *   - addCard 完了 (= spawn 開始) 時点で `ackRecruit(..., { ok: true })`
 *     ※ handshake 完了は待たない (それは既存の handshake 30s 経路で判定する)
 *   - requester カードが見つからない / spawn 失敗 / engine binary 不在 等で
 *     `ackRecruit(..., { ok: false, reason, phase })`
 *
 * ok=true でも MCP の真の成功判定は Hub 側 handshake のみ。renderer の
 * 偽 ack(true) で MCP caller を騙せない多層防御の片側を担う (Phase 1 計画
 * 「設計原則 3」を参照)。
 *
 * IPC contract: `app_recruit_ack(newAgentId, teamId, ok, reason, phase)`
 *   - 引数は flat camelCase 5 個
 *   - reason / phase は省略時 null を送る
 *   - Rust 側は no-op + warn ログで pending 不在 / team_id 不一致 / 重複 ack を吸収
 *
 * Rust 側仕様 (rust_engineer_p1 と並走で確定):
 *   #[tauri::command]
 *   pub async fn app_recruit_ack(
 *       state: State<'_, AppState>,
 *       new_agent_id: String,
 *       team_id: String,
 *       ok: bool,
 *       reason: Option<String>,
 *       phase: Option<String>,
 *   ) -> Result<(), String>
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * ack の失敗理由を表す phase。
 * - `requester_not_found`: `team:recruit-request` の `requesterAgentId` に一致するカードが
 *   canvas store に無く、200ms grace + leader/hr fallback でも見つからなかった。
 * - `spawn`: `terminal.create` IPC が失敗した (PTY allocation failure 等の汎用エラー)。
 * - `engine_binary_missing`: spawn 失敗のうち、`claude` / `codex` 実行ファイルが PATH に
 *   見つからない sub-case (renderer 側で error string ヒューリスティックで分類)。
 * - `instructions_load`: customInstructions 読込が失敗した (将来拡張用、現状未発火)。
 */
export type RecruitAckPhase =
  | 'requester_not_found'
  | 'spawn'
  | 'engine_binary_missing'
  | 'instructions_load';

export interface RecruitAckOutcome {
  ok: boolean;
  /** 失敗理由 (max 256 byte 程度の短文を推奨)。Rust 側で長さ上限ガードあり。 */
  reason?: string;
  /** 失敗 phase。Rust 側は enum で受けるため任意文字列を入れない。 */
  phase?: RecruitAckPhase;
}

/**
 * Hub に recruit-request の受領 / 失敗を通知する。
 *
 * 失敗を invoke してもカードを自分で消さない。Hub が ack を受けて
 * `cancel_pending_recruit` した後に必ず `team:recruit-cancelled` event を emit するため、
 * `useRecruitListener` の cancelled ハンドラで一元的に `removeCard` される。
 * (チャネル方向の一意化: Client→Server は invoke、Server→Client は event)
 */
export async function ackRecruit(
  newAgentId: string,
  teamId: string,
  outcome: RecruitAckOutcome
): Promise<void> {
  await invoke('app_recruit_ack', {
    newAgentId,
    teamId,
    ok: outcome.ok,
    reason: outcome.reason ?? null,
    phase: outcome.phase ?? null
  });
}
