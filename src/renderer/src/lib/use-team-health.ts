/**
 * use-team-health — Issue #510.
 *
 * `team_diagnostics_read` IPC を 5 秒間隔で poll し、agentId をキーにした
 * `Map<agentId, TeamDiagnosticsMemberRow>` を返す軽量 hook。
 *
 * 設計:
 *   - 同 hook を多数の AgentNodeCard が同時にマウントしうるが、teamId 単位で
 *     同じ poll を共有しないと N 倍 IPC が走ってしまう。本実装は最初の caller のみが
 *     活性 poll を持ち、追加 caller は同じ Map に subscribe するだけのレジストリパターン。
 *   - Tab が非フォーカスの間は poll を一時停止する (CPU / IPC コスト削減)。
 *   - teamId が null の間は何もしない。
 *
 * Issue #615: dual preset (`dual-claude-claude` 等) で 2 つの team が同時に active な場合、
 * HUD / TeamDashboard は両方の team を集約する必要がある。`useTeamHealthMulti` は
 * 任意の teamId 配列を購読し、merged な byAgentId と per-team byTeamId を返す。
 */
import { useEffect, useMemo, useState } from 'react';
import type { TeamDiagnosticsMemberRow } from '../../../types/shared';

/** poll 間隔。CPU 負荷と "agent が止まったとき何秒以内に気づくか" のバランス。 */
const POLL_INTERVAL_MS = 5_000;

interface Snapshot {
  /** agentId → 最新行 */
  byAgentId: Record<string, TeamDiagnosticsMemberRow>;
  /** 観測時刻 (Date.now()) */
  fetchedAt: number;
}

interface RegistryEntry {
  refCount: number;
  snapshot: Snapshot | null;
  listeners: Set<(snap: Snapshot | null) => void>;
  timer: number | null;
  /** in-flight な fetch があれば true (同時多重を防ぐ) */
  inflight: boolean;
}

const registry = new Map<string, RegistryEntry>();

function notify(entry: RegistryEntry): void {
  for (const fn of entry.listeners) fn(entry.snapshot);
}

async function fetchOnce(teamId: string, entry: RegistryEntry): Promise<void> {
  if (entry.inflight) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  // window.api が未注入 (test 環境 / Tauri 外) の場合は静かに no-op。
  // unhandled rejection を避けるため一切 invoke を試みない。
  const api =
    typeof window !== 'undefined'
      ? (window as unknown as { api?: { team?: { diagnosticsRead?: unknown } } }).api
      : undefined;
  if (!api?.team || typeof api.team.diagnosticsRead !== 'function') return;
  entry.inflight = true;
  try {
    const res = await window.api.team.diagnosticsRead(teamId);
    const byAgentId: Record<string, TeamDiagnosticsMemberRow> = {};
    for (const m of res.members) byAgentId[m.agentId] = m;
    entry.snapshot = { byAgentId, fetchedAt: Date.now() };
    notify(entry);
  } catch (err) {
    // Hub 未起動など想定内エラーは warn にとどめる (UI は old snapshot で続行)。
    console.warn('[team-health] diagnostics fetch failed:', err);
  } finally {
    entry.inflight = false;
  }
}

function ensurePoll(teamId: string, entry: RegistryEntry): void {
  if (entry.timer !== null) return;
  void fetchOnce(teamId, entry);
  entry.timer = window.setInterval(() => {
    void fetchOnce(teamId, entry);
  }, POLL_INTERVAL_MS);
}

function stopPoll(entry: RegistryEntry): void {
  if (entry.timer !== null) {
    window.clearInterval(entry.timer);
    entry.timer = null;
  }
}

/**
 * teamId に対する diagnostics の最新スナップショットを購読する。
 * 同じ teamId を複数コンポーネントが購読しても poll は 1 回だけ走る。
 */
export function useTeamHealth(
  teamId: string | null
): { byAgentId: Record<string, TeamDiagnosticsMemberRow>; fetchedAt: number | null } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!teamId) {
      setSnapshot(null);
      return;
    }
    let entry = registry.get(teamId);
    if (!entry) {
      entry = {
        refCount: 0,
        snapshot: null,
        listeners: new Set(),
        timer: null,
        inflight: false
      };
      registry.set(teamId, entry);
    }
    entry.refCount += 1;
    const listener = (snap: Snapshot | null) => setSnapshot(snap);
    entry.listeners.add(listener);
    setSnapshot(entry.snapshot);
    ensurePoll(teamId, entry);

    // tab visibility: hidden になったら poll を即停止、戻ったら再 fetch。
    const onVisibility = () => {
      if (!entry) return;
      if (document.hidden) {
        stopPoll(entry);
      } else if (entry.refCount > 0) {
        ensurePoll(teamId, entry);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      const e = registry.get(teamId);
      if (!e) return;
      e.listeners.delete(listener);
      e.refCount -= 1;
      if (e.refCount <= 0) {
        stopPoll(e);
        registry.delete(teamId);
      }
    };
  }, [teamId]);

  return {
    byAgentId: snapshot?.byAgentId ?? {},
    fetchedAt: snapshot?.fetchedAt ?? null
  };
}

/**
 * 複数 teamId の diagnostics を同時購読する。Issue #615。
 *
 * dual / multi preset を canvas に展開した際、HUD は **全 active team の dead/stale**
 * を 1 個の数字に集約する必要がある。本 hook は `useTeamHealth` のレジストリ機構を
 * 各 teamId ごとに再利用し、merged な `byAgentId` と per-team `byTeamId` を返す。
 *
 * - `byAgentId`: agentId はチームを跨いで衝突しない (Hub 側で uuid 採番) ため、
 *   全 team を 1 つの map にマージしても安全。HUD の dead 数集計のように
 *   「agent 単位で 1 回だけ評価したい」用途で使う。
 * - `byTeamId`: TeamDashboard など team ごとに分けて表示したい用途のために、
 *   teamId → byAgentId の per-team snapshot も保持する。
 *
 * teamIds が空配列なら hook は no-op (空 map を返す)。teamIds の順序が異なっても
 * 同一の集合なら同じ snapshot を返すよう、内部では Set で重複除去する。
 */
export function useTeamHealthMulti(teamIds: readonly string[]): {
  byAgentId: Record<string, TeamDiagnosticsMemberRow>;
  byTeamId: Record<string, Record<string, TeamDiagnosticsMemberRow>>;
  fetchedAt: number | null;
} {
  // teamIds 配列の参照ゆれで useEffect が頻繁に再起動しないよう、ソート済みの
  // 安定リストを派生させ、その JSON 表現を effect 依存キーに使う (順序非依存・重複除去)。
  const stableTeamIds = useMemo<string[]>(() => {
    const uniq = Array.from(new Set(teamIds.filter((id) => typeof id === 'string' && id.length > 0)));
    uniq.sort();
    return uniq;
  }, [teamIds]);
  const stableKey = useMemo(() => JSON.stringify(stableTeamIds), [stableTeamIds]);

  const [snapshots, setSnapshots] = useState<Record<string, Snapshot | null>>({});

  useEffect(() => {
    if (stableTeamIds.length === 0) {
      setSnapshots({});
      return;
    }
    // 各 teamId ごとに registry に subscribe する。1 effect 内で複数 entry を持つ。
    const cleanups: Array<() => void> = [];
    for (const teamId of stableTeamIds) {
      let entry = registry.get(teamId);
      if (!entry) {
        entry = {
          refCount: 0,
          snapshot: null,
          listeners: new Set(),
          timer: null,
          inflight: false
        };
        registry.set(teamId, entry);
      }
      entry.refCount += 1;
      const listener = (snap: Snapshot | null) => {
        setSnapshots((prev) => {
          if (prev[teamId] === snap) return prev;
          return { ...prev, [teamId]: snap };
        });
      };
      entry.listeners.add(listener);
      // 既存スナップショットがあれば即座に反映 (poll を待たない)。
      setSnapshots((prev) => ({ ...prev, [teamId]: entry?.snapshot ?? null }));
      ensurePoll(teamId, entry);

      const onVisibility = () => {
        const e = registry.get(teamId);
        if (!e) return;
        if (document.hidden) {
          stopPoll(e);
        } else if (e.refCount > 0) {
          ensurePoll(teamId, e);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);

      cleanups.push(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        const e = registry.get(teamId);
        if (!e) return;
        e.listeners.delete(listener);
        e.refCount -= 1;
        if (e.refCount <= 0) {
          stopPoll(e);
          registry.delete(teamId);
        }
      });
    }
    return () => {
      for (const fn of cleanups) fn();
    };
    // stableKey は stableTeamIds と完全に対応する派生値。eslint への意思表示として両方積む。
  }, [stableKey, stableTeamIds]);

  return useMemo(() => {
    const byAgentId: Record<string, TeamDiagnosticsMemberRow> = {};
    const byTeamId: Record<string, Record<string, TeamDiagnosticsMemberRow>> = {};
    let latestFetchedAt: number | null = null;
    for (const teamId of stableTeamIds) {
      const snap = snapshots[teamId];
      if (!snap) {
        byTeamId[teamId] = {};
        continue;
      }
      byTeamId[teamId] = snap.byAgentId;
      for (const [agentId, row] of Object.entries(snap.byAgentId)) {
        byAgentId[agentId] = row;
      }
      if (latestFetchedAt === null || snap.fetchedAt > latestFetchedAt) {
        latestFetchedAt = snap.fetchedAt;
      }
    }
    return { byAgentId, byTeamId, fetchedAt: latestFetchedAt };
  }, [snapshots, stableTeamIds]);
}
