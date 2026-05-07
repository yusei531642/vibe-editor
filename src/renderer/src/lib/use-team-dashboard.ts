/**
 * use-team-dashboard — Issue #514.
 *
 * Canvas 上の Agent カード群と TeamHub orchestration state を合成して、
 * チーム単位の集約ダッシュボードに必要な行データを返す React hook。
 *
 * 現時点では「Rust 側 diagnostics IPC は MCP 専用で renderer から呼べない」という
 * 制約を踏まえ、以下 3 ソースの合成だけで dashboard を組み立てる:
 *   1. canvas store: agentId / role / agent kind (claude/codex) / cardId / title
 *   2. agent-activity store (#521): activity (idle/typing/thinking) / lastActivityAt
 *      / 派生サマリ (CardSummary)
 *   3. `team_state_read` IPC: tasks (assignedTo / status / blockedReason / nextAction
 *      / requiredHumanDecision / blockedByHumanGate) / human_gate / latestHandoff
 *
 * 5 秒間隔で `team_state_read` を poll する (UI が固まらないことを優先する設計判断)。
 * 将来 Rust 側 diagnostics IPC が生えたら ここから列を追加する想定。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import { useCanvasNodes } from '../stores/canvas-selectors';
import { useAgentActivityStore } from '../stores/agent-activity';
import type { CardData } from '../stores/canvas';
import type {
  TeamOrchestrationState,
  TeamTaskSnapshot
} from '../../../../types/shared';
import type {
  AgentPayload,
  AgentStatus
} from '../components/canvas/cards/AgentNodeCard/types';

const POLL_INTERVAL_MS = 5_000;

/** 1 行 = 1 agent カード分の dashboard 行データ。 */
export interface TeamDashboardRow {
  /** カード id (canvas store の node id) */
  cardId: string;
  /** TeamHub 側の agentId。未設定 (canvas のみ) なら null。 */
  agentId: string | null;
  /** 表示用ラベル (カードタイトル) */
  title: string;
  /** ロール識別子 (`leader` / `planner` / ...) */
  roleProfileId: string;
  /** terminal 種別 (`claude` / `codex`) */
  agent: string;
  /** 画面表示用の集約ステータス */
  state: 'active' | 'blocked' | 'stale' | 'idle' | 'completed';
  /** activity store のリアルタイム値 */
  activity: AgentStatus;
  /** 最後に出力 or 入力イベントを観測した unix ms。null = 未観測。 */
  lastActivityAt: number | null;
  /** assigned task (1 件目)。複数あれば in_progress を優先。 */
  task: TeamTaskSnapshot | null;
  /** Leader 側で対応が要る理由 (blockedReason / handoff_pending / stale など) */
  alert: string | null;
}

/** dashboard サマリ用の集計値。 */
export interface TeamDashboardAggregate {
  total: number;
  active: number;
  blocked: number;
  stale: number;
  completed: number;
  idle: number;
  /** Leader が必ず確認すべき行が 1 つ以上あるか */
  hasAttention: boolean;
}

export interface TeamDashboardData {
  rows: TeamDashboardRow[];
  aggregate: TeamDashboardAggregate;
  /** team_state_read 由来。Leader 行の表示や handoff バナーに使う。 */
  state: TeamOrchestrationState | null;
  /** dashboard が活きていない (= teamId が無い / カード 0 / projectRoot 不明) 状態 */
  empty: boolean;
}

/**
 * dashboard 用の集約データを返す。teamId / projectRoot が確定していない間は空 rows を返す。
 */
export function useTeamDashboard(input: {
  teamId: string | null;
  projectRoot: string | null;
}): TeamDashboardData {
  const { teamId, projectRoot } = input;

  const allNodes = useCanvasNodes();
  const agentNodes = useMemo<Node<CardData>[]>(
    () =>
      allNodes.filter((n) => {
        if (n.type !== 'agent') return false;
        const payload = (n.data as CardData | undefined)?.payload as AgentPayload | undefined;
        return !teamId || payload?.teamId === teamId;
      }),
    [allNodes, teamId]
  );

  const byCard = useAgentActivityStore((s) => s.byCard);

  const [state, setState] = useState<TeamOrchestrationState | null>(null);
  // poll 起動条件: teamId と projectRoot が両方ある場合だけ。状態が変わったら再起動。
  useEffect(() => {
    if (!teamId || !projectRoot) {
      setState(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      window.api.teamState
        .read(projectRoot, teamId)
        .then((next) => {
          if (cancelled) return;
          // 参照同一性で React の再レンダーを抑制: 直近の updatedAt が同じなら更新しない。
          setState((prev) => {
            if (prev && next && prev.updatedAt === next.updatedAt) return prev;
            return next;
          });
        })
        .catch((err) => {
          if (!cancelled) console.warn('[team-dashboard] read failed:', err);
        });
    };
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [teamId, projectRoot]);

  const rows = useMemo<TeamDashboardRow[]>(() => {
    if (agentNodes.length === 0) return [];
    return agentNodes.map((node) => {
      const data = node.data as CardData | undefined;
      const payload = data?.payload as AgentPayload | undefined;
      const agentId = payload?.agentId ?? null;
      const roleProfileId = payload?.roleProfileId ?? payload?.role ?? 'unknown';
      const agentKind = payload?.agent ?? 'claude';
      const title = typeof data?.title === 'string' ? data.title : roleProfileId;
      const runtime = byCard[node.id];
      const activity = runtime?.activity ?? 'idle';
      const lastActivityAt = runtime?.lastActivityAt ?? null;
      const summary = runtime?.summary ?? null;

      // task 抽出: agentId が assignedTo に一致する未完了タスクを優先。
      // 同一 agent に複数 task があれば in_progress > pending > その他の優先順位。
      const candidateTasks = state
        ? state.tasks.filter((t) => agentId !== null && t.assignedTo === agentId)
        : [];
      const orderedTasks = candidateTasks.slice().sort((a, b) => {
        const score = (s: string) => (s === 'in_progress' ? 0 : s === 'pending' ? 1 : 2);
        return score(a.status) - score(b.status);
      });
      const task = orderedTasks[0] ?? null;

      // 集約ステータス: handoff acked → completed、blocked task / human_gate → blocked、
      // summary.isStale → stale、active → active、それ以外 → idle。
      let computed: TeamDashboardRow['state'] = 'idle';
      if (summary?.isCompleted) computed = 'completed';
      else if (
        task?.status === 'blocked' ||
        task?.blockedByHumanGate ||
        summary?.needsLeaderInput
      )
        computed = 'blocked';
      else if (summary?.isStale) computed = 'stale';
      else if (summary?.isActive) computed = 'active';

      const alert = (() => {
        if (computed === 'blocked') {
          return (
            task?.blockedReason ??
            task?.requiredHumanDecision ??
            (state?.humanGate.blocked ? state.humanGate.reason ?? null : null) ??
            'Leader 入力待ち'
          );
        }
        if (computed === 'stale') return '5 分以上出力なし';
        return null;
      })();

      return {
        cardId: node.id,
        agentId,
        title,
        roleProfileId,
        agent: agentKind,
        state: computed,
        activity,
        lastActivityAt,
        task,
        alert
      };
    });
  }, [agentNodes, byCard, state]);

  const aggregate = useMemo<TeamDashboardAggregate>(() => {
    let active = 0;
    let blocked = 0;
    let stale = 0;
    let completed = 0;
    let idle = 0;
    for (const r of rows) {
      switch (r.state) {
        case 'active':
          active += 1;
          break;
        case 'blocked':
          blocked += 1;
          break;
        case 'stale':
          stale += 1;
          break;
        case 'completed':
          completed += 1;
          break;
        default:
          idle += 1;
      }
    }
    return {
      total: rows.length,
      active,
      blocked,
      stale,
      completed,
      idle,
      hasAttention: blocked > 0 || stale > 0
    };
  }, [rows]);

  return {
    rows,
    aggregate,
    state,
    empty: rows.length === 0
  };
}
