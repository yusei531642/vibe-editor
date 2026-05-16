/**
 * App — IDE モードのルート。
 *
 * Issue #731: 旧 App.tsx は 1136 行の god component で、`useProjectLoader` /
 * `useFileTabs` / `useTerminalTabs` / `useTeamManagement` を逐次呼び出しながら
 * hook 間の循環参照を 5 連発の `useRef` ブリッジで先送りしていた。
 *
 * これを 2 つに分解した:
 *   - `AppStateProvider` (lib/app-state-context.tsx) — hook 統合層と ref ブリッジ
 *     を内包し、`useProject()` / `useTabs()` / `useTeam()` の 3 consumer hook で
 *     必要な slice だけを公開する。
 *   - `AppShell` (components/AppShell.tsx) — 画面本体 (巨大 JSX + 画面ローカル
 *     state / derived / handler)。3 consumer hook で状態を購読する。
 *
 * よって App はこの「Provider tree + 画面本体マウント」だけを担う。ref ブリッジは
 * 完全に AppStateProvider 内部へ閉じ込められ、ここからは見えない (callbacks-down /
 * events-up の依存性逆転)。
 */
import { useState } from 'react';
import type { SessionInfo } from '../../types/shared';
import { useWindowFrameInsets } from './lib/use-window-frame-insets';
import { AppStateProvider } from './lib/app-state-context';
import { AppShell } from './components/AppShell';

export function App(): JSX.Element {
  // Issue #307: Windows 11 フレームレス最大化時の不可視リサイズ境界を CSS 変数で補正。
  useWindowFrameInsets();

  // セッションパネル UI の state。AppStateProvider の `onSessionsLoaded`
  // (events-up: loadProject が取得した初期 sessions を流す) と AppShell の
  // セッションパネル (callbacks-down) の両方から触れるよう、共通の親である
  // App が hold する。旧 App.tsx では同コンポーネント内の useState だった。
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  return (
    <AppStateProvider onSessionsLoaded={setSessions}>
      <AppShell sessions={sessions} setSessions={setSessions} />
    </AppStateProvider>
  );
}
