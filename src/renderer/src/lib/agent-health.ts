/**
 * agent-health — Issue #510.
 *
 * `TeamDiagnosticsMemberRow` 1 行を、UI に出す 3 値ヘルス (alive / stale / dead) と
 * 経過秒の表示に変換する純粋関数。Rust 側 #524 で生えた `autoStale` を一次判定に使い、
 * 「どれくらい長く沈黙していれば dead と見なすか」だけ renderer 側で重ね判定する。
 *
 * `dead` は `lastPtyActivityAgeMs` が `DEAD_THRESHOLD_MS` を超えるとき (PTY 出力が
 * 15 分以上途絶した = プロセスが本当に動いていない決定的シグナル)。
 * Hub の `autoStale` が true でも「動いている (PTY 出力あり) が status 申告だけ古い」
 * ケースは dead にしない。`lastStatusAgeMs` は `alive` 判定の補助 (status / PTY の
 * いずれかが観測されていれば alive 候補) としてのみ参照する。
 */
import type { TeamDiagnosticsMemberRow } from '../../../types/shared';

/**
 * 「もう動いていない」と見なす経過時間 (ms)。
 * `STATUS_STALE_THRESHOLD_SECS` (Hub 側 5 分) の 3 倍 = 15 分。
 * これ以上沈黙する worker は手動介入が必要なケースが大半。
 */
export const DEAD_THRESHOLD_MS = 15 * 60_000;

export type HealthState = 'alive' | 'stale' | 'dead' | 'unknown';

export interface HealthDerived {
  state: HealthState;
  /** 表示用: 「最終出力からどれだけ経ったか」を `formatRelativeMs` 互換に整形 */
  ageMs: number | null;
  /** 自己申告ステータス文字列。null / 空なら未申告。 */
  currentStatus: string | null;
  /** pendingInbox 数 (UI で badge 表示) */
  pendingInboxCount: number;
  /** 一番古い pending inbox の経過時間。未読なし / 不明なら null。 */
  oldestPendingInboxAgeMs: number | null;
  /** Hub 側が「未読が長く残っている」と判定したか。 */
  stalledInbound: boolean;
}

function ageFromRfc3339(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, now - ms);
}

export function deriveHealth(
  row: TeamDiagnosticsMemberRow | null | undefined,
  now: number = Date.now()
): HealthDerived {
  if (!row) {
    return {
      state: 'unknown',
      ageMs: null,
      currentStatus: null,
      pendingInboxCount: 0,
      oldestPendingInboxAgeMs: null,
      stalledInbound: false
    };
  }

  // Issue #910: use-team-health が age 系フィールドだけの変化では snapshot を固定する。
  // 経過表示と stale/dead 判定が止まらないよう、安定な RFC3339 timestamp から
  // クライアント側の now に対する age を再計算する。timestamp が読めない旧データだけ
  // Hub が返した age にフォールバックする。
  const lastStatusAgeMs =
    ageFromRfc3339(row.lastStatusAt, now) ?? row.lastStatusAgeMs;
  const lastPtyActivityAgeMs =
    ageFromRfc3339(row.lastPtyOutputAt, now) ?? row.lastPtyActivityAgeMs;
  const ageMs = lastPtyActivityAgeMs ?? lastStatusAgeMs;

  const statusIsStale =
    lastStatusAgeMs === null || lastStatusAgeMs >= row.stalenessThresholdMs;
  const ptyIsRecentlyActive =
    lastPtyActivityAgeMs !== null && lastPtyActivityAgeMs < row.stalenessThresholdMs;
  const autoStale = statusIsStale && !ptyIsRecentlyActive;

  let state: HealthState;
  if (lastPtyActivityAgeMs !== null && lastPtyActivityAgeMs >= DEAD_THRESHOLD_MS) {
    // PTY 出力が 15 分以上途絶 → dead。lastStatusAgeMs もチェックしないのは、
    // status 申告は agent が忘れがちなので、PTY の絶対沈黙が確定的シグナル。
    state = 'dead';
  } else if (row.autoStale || autoStale) {
    state = 'stale';
  } else if (lastPtyActivityAgeMs !== null || lastStatusAgeMs !== null) {
    state = 'alive';
  } else {
    // 1 度も観測されていない (= recruit 直後の handshake 前) は unknown 扱い。
    state = 'unknown';
  }

  return {
    state,
    ageMs: ageMs ?? null,
    currentStatus: row.currentStatus,
    pendingInboxCount: row.pendingInboxCount,
    oldestPendingInboxAgeMs: row.oldestPendingInboxAgeMs,
    stalledInbound: row.stalledInbound
  };
}
