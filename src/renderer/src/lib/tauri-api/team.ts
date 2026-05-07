/**
 * tauri-api/team — Canvas 上のチーム / マルチエージェント運用に関する renderer 側 wrapper。
 *
 * Issue #521 (Renderer Canvas UI): カードと Canvas 全体の状態要約 UI を支える wrapper を集約。
 * Issue #511 (Rust TeamHub Ops): inject 失敗時の retry / listener wrapper はこの namespace に
 *   後追いで append する想定 (`team.retryInject` / `team.onInjectFailed`)。
 *
 * 現時点で Rust 側に `team_summary_*` IPC は無いので、`team.summary()` は CardFrame 側で
 * 集めた `cardSummaries` レコードから純粋関数 `aggregateTeamSummary` を呼ぶだけの薄い
 * thunk wrapper として動かす。Issue #510 / #514 の diagnostics + tasks IPC が入ったら、
 * ここで invoke を併用して実値を流し込めるようにする。
 */
import type { Node } from '@xyflow/react';
import type { CardData } from '../../stores/canvas';
import {
  aggregateTeamSummary,
  type CardSummary,
  type TeamSummaryAggregate
} from '../agent-summary';

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
  }
};
