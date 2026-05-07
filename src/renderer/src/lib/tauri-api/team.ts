/**
 * tauri-api/team — Canvas 上のチーム / マルチエージェント運用に関する renderer 側 wrapper。
 *
 * Issue #521 (Renderer Canvas UI): カードと Canvas 全体の状態要約 UI を支える wrapper を集約。
 * Issue #511 (Rust TeamHub Ops): inject 失敗時の手動リトライ用 wrapper を `team.retryInject` で追加。
 *   `team:inject_failed` event の listener は `lib/use-team-inject-failed.ts` に集約 (use-team-handoff
 *   と同じ Issue #158 / #192 パターン) しているのでここでは扱わない。
 *
 * 現時点で Rust 側に `team_summary_*` IPC は無いので、`team.summary()` は CardFrame 側で
 * 集めた `cardSummaries` レコードから純粋関数 `aggregateTeamSummary` を呼ぶだけの薄い
 * thunk wrapper として動かす。Issue #510 / #514 の diagnostics + tasks IPC が入ったら、
 * ここで invoke を併用して実値を流し込めるようにする。
 */
import { invoke } from '@tauri-apps/api/core';
import type { Node } from '@xyflow/react';
import type { CardData } from '../../stores/canvas';
import {
  aggregateTeamSummary,
  type CardSummary,
  type TeamSummaryAggregate
} from '../agent-summary';
import type {
  RetryInjectArgs,
  RetryInjectResult,
  TeamDiagnosticsMemberRow
} from '../../../../types/shared';

/**
 * Issue #510: `team_diagnostics_read` IPC の戻り値。Rust 側 `team_diagnostics` 関数の
 * outer JSON shape (`{ myAgentId, myRole, teamId, serverLogPath, members[] }`) を
 * そのまま投影する。renderer は基本 `members` だけを使う。
 */
export interface TeamDiagnosticsResponse {
  myAgentId: string;
  myRole: string;
  teamId: string;
  serverLogPath: string | null;
  members: TeamDiagnosticsMemberRow[];
}

export interface TeamSummaryRequest {
  /** 集計対象の agent ノード (caller 側で type === 'agent' フィルタ済み) */
  agentNodes: Node<CardData>[];
  /** カード id → 直近の派生サマリ */
  cardSummaries: Record<string, CardSummary>;
}

export const team = {
  /**
   * 全 agent カードの CardSummary を集計して HUD 用の数値を返す。
   * 同期計算だが将来 Rust 側 diagnostics と合成しても呼び口を変えないよう Promise を返す。
   */
  summary(req: TeamSummaryRequest): Promise<TeamSummaryAggregate> {
    return Promise.resolve(
      aggregateTeamSummary({
        agentNodes: req.agentNodes,
        cardSummaries: req.cardSummaries
      })
    );
  },
  /**
   * Issue #511: `team_send` の partial failure に対する手動リトライ。
   *
   * - 成功時: `{ ok: true, deliveredAt }` を返し、Hub は `team:handoff` event を emit する。
   * - 再失敗時: `{ ok: false, reasonCode, error, failedAt }` を返し、Hub は `team:inject_failed` event を再 emit する。
   * - 不正引数 (unknown team / message が evict 済み / agentId が recipient でない) は `Err(string)` で reject される。
   *   reject されたエラー文字列は JSON `{"code":"retry_*","message":"..."}` 形式。caller は `JSON.parse()` で分岐できる。
   */
  retryInject: (args: RetryInjectArgs): Promise<RetryInjectResult> =>
    invoke('team_send_retry_inject', { args }),
  /**
   * Issue #510: TeamHub の per-member 診断値を Leader 視点で取得する。
   * 内部で leader 役を impersonate して MCP `team_diagnostics` と同一データを返す。
   * Hub 未起動 / team 未登録時も基本的に空 members で返る (errors は reject)。
   */
  diagnosticsRead: (teamId: string): Promise<TeamDiagnosticsResponse> =>
    invoke('team_diagnostics_read', { teamId })
};
