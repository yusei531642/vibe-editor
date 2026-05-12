import type { ViewMode } from '../stores/ui';

/**
 * Topbar マスコットの状態モデル (Issue #717)。
 * 編集 / レビュー / git の細かい状態はあえて持たず、「マスコットの動きとして
 * 表現したい挙動」だけを enum 化する:
 *  - idle: 待機。ゆらゆら浮遊
 *  - sleep: 3 分以上入力なし。横向きで ZZZ
 *  - working: エージェント実行中。走る / 跳ねる
 *  - thinking: LLM 応答待ち。... ドットが点滅
 *  - done: タスク完了直後 (1.6s で idle 復帰)。ジャンプ + ✓
 *  - error: 失敗 / blocked。横揺れ + 赤
 *  - excited: ユーザーがクリック (1.2s で idle 復帰)。バウンス + ✨
 *
 * `getStatusMascotState()` が返すのは「base 状態」(idle / working / thinking
 * / error) だけ。sleep / excited / done のような時間 or 入力ベースの上書きは
 * `useMascotOrchestrator()` が担う。
 */
export type StatusMascotState =
  | 'idle'
  | 'sleep'
  | 'working'
  | 'thinking'
  | 'done'
  | 'error'
  | 'excited';

export interface StatusMascotTerminalSnapshot {
  status: string;
  exited: boolean;
  hasActivity: boolean;
  /** terminal 出力が来てから一定時間止まっていれば LLM 応答待ち扱い */
  awaitingResponse?: boolean;
}

export interface StatusMascotSnapshot {
  viewMode: ViewMode;
  activeFilePath: string | null;
  activeEditorDirty: boolean;
  hasActiveDiff: boolean;
  gitChangeCount: number;
  terminals: StatusMascotTerminalSnapshot[];
}

/**
 * 入力 (terminal) から base 状態を導出する。
 * - 1 つでも blocked (exit / 失敗ステータス) があれば `error`
 * - 1 つでも activity / starting があれば `working`
 * - 起動済みだが activity が無く `awaitingResponse=true` のものがあれば `thinking`
 * - それ以外は `idle`
 *
 * `editing` / `dirty` / `reviewing` は mascot 視点では全部 idle に集約する
 * (Issue #717: state モデルを「動きとして表現したい」7 種類に絞る)。
 */
export function getStatusMascotState(snapshot: StatusMascotSnapshot): StatusMascotState {
  const hasBlocked = snapshot.terminals.some(
    (terminal) => terminal.exited || isBlockedStatus(terminal.status)
  );
  if (hasBlocked) return 'error';

  const hasRunning = snapshot.terminals.some(
    (terminal) => terminal.hasActivity || isStartingStatus(terminal.status)
  );
  if (hasRunning) return 'working';

  const hasThinking = snapshot.terminals.some((terminal) => terminal.awaitingResponse);
  if (hasThinking) return 'thinking';

  return 'idle';
}

function isStartingStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    status.includes('起動中') ||
    status.includes('再接続') ||
    normalized.includes('starting') ||
    normalized.includes('reconnect')
  );
}

function isBlockedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    status.includes('起動失敗') ||
    status.includes('例外') ||
    status.includes('終了') ||
    normalized.includes('failed') ||
    normalized.includes('exception') ||
    normalized.includes('exit')
  );
}
