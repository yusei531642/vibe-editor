# Issue #469 - Canvas mode file tree width

## 計画

- 対象: https://github.com/yusei531642/vibe-editor/issues/469
- Branch: `feature/issue-469`
- Tier: C
- RCA Mode: Root Cause Confirmed

### RCA結果

- 症状: Canvas モードのファイルツリー表示領域が IDE モードより広くなり、常時表示しづらい。
- 再現根拠: Issue 本文と既存計画コメントで Canvas / IDE の表示幅差分が報告済み。
- 原因箇所: `src/renderer/src/styles/components/canvas.css` の `.canvas-layout__body` 配下。
- 原因経路: IDE モードは `.layout.layout--redesign` の grid column で `var(--shell-sidebar-w)` を使う一方、Canvas モードは `Rail` / `CanvasSidebar` / stage を flex 配置しており、`CanvasSidebar` が再利用する `.sidebar` に Canvas 限定の幅制約がない。
- 修正方針: Canvas の親レイアウト側で `.canvas-layout__body > .sidebar` を `var(--shell-sidebar-w)` に固定する。`Sidebar` / `FileTreePanel` / `CanvasSidebar` のロジックは変更しない。

### 実装ステップ

- [x] `canvas.css` に Canvas 限定の Sidebar sizing contract を追加する。
- [x] CSS contract test を追加し、Canvas sidebar が `--shell-sidebar-w` を参照することを固定する。
- [x] `npm run typecheck` と対象 Vitest を実行する。
- [x] Vite / browser smoke で Canvas レイアウトの描画を確認する。

## 進捗

- `.canvas-layout__body > .sidebar` を `flex: 0 0 var(--shell-sidebar-w)` / `width` / `min-width` / `max-width` で固定した。
- `src/renderer/src/styles/__tests__/canvas-css-contract.test.ts` を追加し、IDE と Canvas が同じ `--shell-sidebar-w` token を使うことを検証した。
- Vite 単体の browser smoke では Canvas モードへの切替と Canvas header / Rail / sidebar / stage の DOM 表示を確認した。Tauri API 未注入に由来する既存 console error は Vite 単体起動の制約として扱う。
- Dev server: `http://127.0.0.1:5174/`

## 検証結果

- [x] `npx vitest run src/renderer/src/styles/__tests__/canvas-css-contract.test.ts`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (30 files / 197 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS

## Next Steps

- PR を作成する場合は本文に `Closes #469` と検証結果を記載する。
- CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。
