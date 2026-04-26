import { useState } from 'react';
import type { TeamRole } from '../../../types/shared';
import { useTeamHandoff } from './use-team-handoff';

/**
 * ActivityEvent — ActivityPanel が表示するイベントの共通型。
 * handoff: Rust TeamHub の team:handoff event (team_send / team_assign_task 由来)
 * status:  terminal onStatus ('ready' 等) や session 作成
 * error:   error トーストや pty exit
 */
export interface ActivityEvent {
  id: string;
  ts: number;
  kind: 'handoff' | 'status' | 'error' | 'system';
  role?: TeamRole | null;
  fromRole?: TeamRole | string | null;
  toRole?: TeamRole | string | null;
  title: string;
  body?: string;
  teamName?: string | null;
}

/** ring buffer 最大件数。古いものから捨てる。 */
const MAX_EVENTS = 200;

/**
 * チームの handoff / システム系のイベントを時系列で保持するフック。
 * Canvas だけでなく IDE シェルでも利用可。
 */
export function useActivityFeed(): {
  events: ActivityEvent[];
  push: (e: Omit<ActivityEvent, 'id' | 'ts'> & { ts?: number }) => void;
  clear: () => void;
} {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  // Issue #158: Rust TeamHub の team:handoff は use-team-handoff の集約 listener 経由で
  // 受け取る。Canvas など他の購読者と Tauri 側 listen を共有するので二重登録にならない。
  useTeamHandoff((p) => {
    const ts = Date.now();
    const ev: ActivityEvent = {
      id: `handoff-${p.messageId}-${ts}`,
      ts,
      kind: 'handoff',
      fromRole: p.fromRole,
      toRole: p.toRole,
      title: `${p.fromRole} → ${p.toRole}`,
      body: p.preview
    };
    setEvents((prev) => {
      const next = [ev, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  });

  return {
    events,
    push: (partial) => {
      const ts = partial.ts ?? Date.now();
      const ev: ActivityEvent = {
        ...partial,
        id: `${partial.kind}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        ts
      };
      setEvents((prev) => {
        const next = [ev, ...prev];
        return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
      });
    },
    clear: () => setEvents([])
  };
}

/**
 * event 群を "Just now / N min ago / N h ago / Earlier" の bucket に分ける。
 */
export function groupEventsByRecency(
  events: ActivityEvent[],
  now = Date.now()
): Array<{ key: 'now' | 'minute' | 'hour' | 'earlier'; items: ActivityEvent[] }> {
  const buckets: Record<'now' | 'minute' | 'hour' | 'earlier', ActivityEvent[]> = {
    now: [],
    minute: [],
    hour: [],
    earlier: []
  };
  for (const ev of events) {
    const ageSec = (now - ev.ts) / 1000;
    if (ageSec < 60) buckets.now.push(ev);
    else if (ageSec < 60 * 60) buckets.minute.push(ev);
    else if (ageSec < 60 * 60 * 24) buckets.hour.push(ev);
    else buckets.earlier.push(ev);
  }
  return (['now', 'minute', 'hour', 'earlier'] as const)
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, items: buckets[k] }));
}
