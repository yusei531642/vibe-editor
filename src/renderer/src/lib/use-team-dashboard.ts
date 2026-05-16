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
 *
 * Issue #615: dual / multi preset 対応のため `useTeamDashboardMulti` を提供。
 * 単一 teamId 用 `useTeamDashboard` は薄いラッパとして残す (後方互換)。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import { useCanvasNodes } from '../stores/canvas-selectors';
import { useAgentActivityStore } from '../stores/agent-activity';
import { agentPayloadOf, type CardData } from '../stores/canvas';
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

/** Issue #615: multi-team 用に 1 つの section データを表す。 */
export interface TeamDashboardSection {
  teamId: string;
  rows: TeamDashboardRow[];
  aggregate: TeamDashboardAggregate;
  state: TeamOrchestrationState | null;
}

/** Issue #615: dual / multi preset 用に全 team を集約した dashboard データ。 */
export interface MultiTeamDashboardData {
  /** team ごとの section (teamIds の順序を保つ)。 */
  sections: TeamDashboardSection[];
  /** 全 team を合算した Canvas 全体集計。HUD ピル・空表示判定に使う。 */
  total: TeamDashboardAggregate;
  /** 全 sections の rows.length が 0 の状態 (= dashboard を出す意味がない)。 */
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
        const payload = agentPayloadOf(n.data as CardData | undefined);
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
      const payload = agentPayloadOf(data);
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

/**
 * Issue #615: 複数 teamId 用の dashboard データ。
 *
 * dual preset (`dual-claude-claude` 等) で 2 つの team が canvas に並ぶケースに対応。
 * 各 teamId ごとに `team_state_read` IPC を 5 秒間隔で poll し、合算した集計を返す。
 *
 * - 単一 teamId のときは長さ 1 の `sections` を返すので従来挙動と等価。
 * - teamIds は呼び出し側が「Leader を持つ team を先頭に」並べた順序を保持する。
 * - projectRoot が null の場合は state poll を行わず canvas 上の情報だけで構成する
 *   (rows は出るが task / human_gate は付かない)。
 */
export function useTeamDashboardMulti(input: {
  teamIds: readonly string[];
  projectRoot: string | null;
}): MultiTeamDashboardData {
  const { teamIds, projectRoot } = input;

  // teamIds 配列の参照ゆれで useEffect が頻繁に再起動しないよう、安定リスト + JSON key に正規化。
  const stableTeamIds = useMemo<string[]>(() => {
    const uniq = Array.from(
      new Set(teamIds.filter((id) => typeof id === 'string' && id.length > 0))
    );
    return uniq;
  }, [teamIds]);
  const stableKey = useMemo(() => JSON.stringify(stableTeamIds), [stableTeamIds]);

  const allNodes = useCanvasNodes();
  // teamId ごとに agent ノードを分けて持つ。teamIds に含まれる team のみ対象。
  const nodesByTeam = useMemo<Record<string, Node<CardData>[]>>(() => {
    const out: Record<string, Node<CardData>[]> = {};
    for (const id of stableTeamIds) out[id] = [];
    for (const n of allNodes) {
      if (n.type !== 'agent') continue;
      const payload = (n.data as CardData | undefined)?.payload as AgentPayload | undefined;
      const tid = payload?.teamId;
      if (tid && out[tid]) out[tid].push(n);
    }
    return out;
  }, [allNodes, stableTeamIds]);

  const byCard = useAgentActivityStore((s) => s.byCard);

  const [stateByTeam, setStateByTeam] = useState<Record<string, TeamOrchestrationState | null>>({});

  // 全 teamId を 1 つの effect で並列 poll する。teamIds が変わったら全体を再構築する。
  useEffect(() => {
    if (stableTeamIds.length === 0 || !projectRoot) {
      setStateByTeam({});
      return;
    }
    let cancelled = false;
    const tickFor = (teamId: string) => {
      window.api.teamState
        .read(projectRoot, teamId)
        .then((next) => {
          if (cancelled) return;
          setStateByTeam((prev) => {
            const cur = prev[teamId] ?? null;
            if (cur && next && cur.updatedAt === next.updatedAt) return prev;
            return { ...prev, [teamId]: next };
          });
        })
        .catch((err) => {
          if (!cancelled) console.warn('[team-dashboard-multi] read failed:', err);
        });
    };
    // 初回は全 teamId を並列 fetch。
    for (const id of stableTeamIds) tickFor(id);
    const intervalId = window.setInterval(() => {
      for (const id of stableTeamIds) tickFor(id);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [stableKey, stableTeamIds, projectRoot]);

  const sections = useMemo<TeamDashboardSection[]>(() => {
    return stableTeamIds.map((teamId) => {
      const nodes = nodesByTeam[teamId] ?? [];
      const state = stateByTeam[teamId] ?? null;
      const rows: TeamDashboardRow[] = nodes.map((node) => {
        const data = node.data as CardData | undefined;
        const payload = agentPayloadOf(data);
        const agentId = payload?.agentId ?? null;
        const roleProfileId = payload?.roleProfileId ?? payload?.role ?? 'unknown';
        const agentKind = payload?.agent ?? 'claude';
        const title = typeof data?.title === 'string' ? data.title : roleProfileId;
        const runtime = byCard[node.id];
        const activity = runtime?.activity ?? 'idle';
        const lastActivityAt = runtime?.lastActivityAt ?? null;
        const summary = runtime?.summary ?? null;

        const candidateTasks = state
          ? state.tasks.filter((t) => agentId !== null && t.assignedTo === agentId)
          : [];
        const orderedTasks = candidateTasks.slice().sort((a, b) => {
          const score = (s: string) => (s === 'in_progress' ? 0 : s === 'pending' ? 1 : 2);
          return score(a.status) - score(b.status);
        });
        const task = orderedTasks[0] ?? null;

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
      const aggregate: TeamDashboardAggregate = {
        total: rows.length,
        active,
        blocked,
        stale,
        completed,
        idle,
        hasAttention: blocked > 0 || stale > 0
      };

      return { teamId, rows, aggregate, state };
    });
  }, [stableTeamIds, nodesByTeam, stateByTeam, byCard]);

  const total = useMemo<TeamDashboardAggregate>(() => {
    let total = 0;
    let active = 0;
    let blocked = 0;
    let stale = 0;
    let completed = 0;
    let idle = 0;
    for (const s of sections) {
      total += s.aggregate.total;
      active += s.aggregate.active;
      blocked += s.aggregate.blocked;
      stale += s.aggregate.stale;
      completed += s.aggregate.completed;
      idle += s.aggregate.idle;
    }
    return {
      total,
      active,
      blocked,
      stale,
      completed,
      idle,
      hasAttention: blocked > 0 || stale > 0
    };
  }, [sections]);

  return {
    sections,
    total,
    empty: sections.every((s) => s.rows.length === 0)
  };
}
