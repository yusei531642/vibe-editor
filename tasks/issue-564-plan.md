# Issue #564 - IDE initial screen must not auto-start terminals

## 計画

- Issue #443 との違いを整理する。#443 は初期ターミナルの表示崩れ、#564 は初期ターミナル生成そのものを止める。
- `use-terminal-tabs.ts` の自動生成経路をすべて確認する。
- Canvas / Team 側の TerminalView が IDE モードでも裏で mount されないか確認する。
- IDE 初期表示で `terminalTabs.length === 0` を正とし、`addTerminalTab()` を自動実行しない。
- 最後のタブを閉じても、代替の `Claude #1` を自動生成しない。
- project switch reset でも `Claude #1` を自動生成しない。
- Canvas が非表示の間は TerminalView の PTY spawn を延期する。
- 回帰テストで IDE tabs 3 経路と Canvas hidden spawn 経路を固定する。
- `tasks/lessons.md` に再発防止を追記する。

## Next Steps

- [x] Issue #564 を作成する。
- [x] `src/renderer/src/lib/hooks/use-terminal-tabs.ts` を最小修正する。
- [x] `use-terminal-tabs` の回帰テストを追加する。
- [x] Canvas hidden spawn の回帰テストを追加する。
- [x] 関連 Vitest、typecheck、build、diff check を通す。
- [x] `npm run dev` 相当で IDE 初期表示時に `terminal_create` が出ないことを確認する。

## 進捗

- [x] `use-terminal-tabs.ts` に 3 つの自動生成経路があることを確認。
  - 初期 effect: `claudeReady && projectRoot && terminalTabs.length === 0 && viewMode === 'ide'`
  - 最後のタブ close: 空配列の代わりに `Claude #1` を生成
  - project switch reset: `Claude #1` を生成
- [x] ローカル dev で初回仮説が不足していることを確認。
  - `terminal_create command=claude` と `terminal_create command=codex` が IDE 起動直後に出た。
  - `main.tsx` は CanvasLayout を常時 mount し、IDE では `display:none` にしている。
  - そのため保存済み Canvas / Team ノードの TerminalView が非表示で PTY を起動していた。
- [x] `TerminalView` に `spawnEnabled` ゲートを追加し、`visible=false` では PTY spawn を延期。
- [x] `TerminalCard` / `TerminalOverlay` は Canvas 表示中だけ `visible=true` を渡す。

## 検証結果

- [x] `npx vitest run src/renderer/src/lib/hooks/__tests__/use-terminal-tabs.test.tsx`: PASS
- [x] `npx vitest run src/renderer/src/lib/hooks/__tests__/use-xterm-bind.test.tsx`: PASS
- [x] `npx vitest run src/renderer/src/components/canvas/cards/__tests__/TerminalCard.test.tsx src/renderer/src/components/canvas/cards/AgentNodeCard/__tests__/TerminalOverlay.test.tsx`: PASS
- [x] `npx vitest run src/renderer/src/lib/hooks/__tests__/use-terminal-tabs.test.tsx src/renderer/src/lib/hooks/__tests__/use-xterm-bind.test.tsx src/renderer/src/components/canvas/cards/__tests__/TerminalCard.test.tsx src/renderer/src/components/canvas/cards/AgentNodeCard/__tests__/TerminalOverlay.test.tsx`: PASS (12 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS
- [x] Tauri dev 起動確認: isolated dev identifier / port 5174 で起動後 10 秒、`terminal_create` / `spawn command requested` / `[起動エラー]` なし。
- [x] 参考: 通常 dev profile では persisted `vibe-editor:ui.viewMode=canvas` のため Canvas agent が起動した。IDE 初期表示の検証条件と分けて扱う。

## Next Tasks

- PR URL を追記する。
