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
 */
import { useEffect, useState } from 'react';
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
