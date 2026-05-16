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

export function deriveHealth(
  row: TeamDiagnosticsMemberRow | null | undefined
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

  // 「最終出力 (= プロセスが本当に動いた最後の物理シグナル)」を最も信頼する。
  // PTY 出力時刻が無いときは status 申告の age をフォールバック表示。
  const ageMs = row.lastPtyActivityAgeMs ?? row.lastStatusAgeMs;

  let state: HealthState;
  if (row.lastPtyActivityAgeMs !== null && row.lastPtyActivityAgeMs >= DEAD_THRESHOLD_MS) {
    // PTY 出力が 15 分以上途絶 → dead。lastStatusAgeMs もチェックしないのは、
    // status 申告は agent が忘れがちなので、PTY の絶対沈黙が確定的シグナル。
    state = 'dead';
  } else if (row.autoStale) {
    state = 'stale';
  } else if (row.lastPtyActivityAgeMs !== null || row.lastStatusAgeMs !== null) {
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
