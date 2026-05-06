/**
 * use-pty-session — 旧 788 行の単一ファイル hook を以下の 2 hook + 互換 wrapper に
 * 整理した (Issue #487):
 *
 *   - `lib/hooks/use-xterm-bind.ts`  — 初回接続 + subscribeEventReady pre-subscribe
 *     を行う中核 hook 本体。
 *   - `lib/hooks/use-hmr-recover.ts` — HMR 判定 (`hmrDisposeArmed`) と再接続用
 *     ptyId キャッシュ。`import.meta.hot.dispose` の登録もここで一度だけ行う。
 *
 * 本ファイルは 2 つを組み合わせる薄い wrapper にし、公開シンボル
 * (`usePtySession` / `PtySpawnSnapshot` / `PtySessionCallbacks` /
 *  `UsePtySessionOptions`) は不変のまま再 export する。これにより
 * `components/TerminalView.tsx` や `__tests__/use-pty-session-*.test.tsx` の
 * import path / 型が変わらない。
 */
import {
  useXtermBind,
  type PtySessionCallbacks,
  type PtySpawnSnapshot,
  type UseXtermBindOptions
} from './hooks/use-xterm-bind';

export type { PtySessionCallbacks, PtySpawnSnapshot };

/** `usePtySession` の旧 options 型エイリアス。中身は `UseXtermBindOptions` と同一。 */
export type UsePtySessionOptions = UseXtermBindOptions;

export function usePtySession(options: UsePtySessionOptions): void {
  useXtermBind(options);
}
