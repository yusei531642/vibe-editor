## 実装計画

### ゴール
Canvas モードで Codex 側のターミナルカードでも、スクロールバー (xterm の vertical scrollbar thumb) をマウスで掴んでドラッグできる状態にする。Claude 側と同じ操作感に揃える。マウスホイールでのスクロールは現状維持。

### 影響範囲 / 触るファイル
- `src/renderer/src/components/canvas/cards/TerminalCard.tsx` — terminal wrapper に `nodrag` (および必要なら `nowheel`) クラスを付与し、xterm DOM 上でのドラッグを React Flow が奪わないようにする
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` — Codex がこちら側で描画されているケースのため、`canvas-agent-card__term` 配下で scrollbar 領域に `nodrag` が確実に効いているか再点検 (現状の `nodrag` 付与位置がスクロールバー DOM までカバーしているかを確認し、必要なら xterm の `.xterm-scrollable-element > .scrollbar.vertical` まで継承させる)
- `src/renderer/src/styles/components/canvas.css` — `pointer-events: auto !important` の対象セレクタを TerminalCard 配下にも揃える (現状 614 行付近の上書きが AgentNodeCard 寄りなら、TerminalCard 用の `.canvas-terminal-card__term .xterm-scrollable-element > .scrollbar.vertical` も追加)
- (該当時) `src/renderer/src/components/canvas/CardFrame.tsx` — `onPointerDown` の `stopPropagation` がスクロールバー drag を妨げていないか確認し、scrollbar 領域では伝播させるよう調整

### 実装ステップ
- [ ] Step 1: 再現確認 — Canvas モードで Claude / Codex 両方を起動し、スクロールバー thumb のドラッグ可否を実機検証 (どちらが TerminalCard / AgentNodeCard で描画されているかを DevTools で特定する。仮説では Codex が TerminalCard 経由)
- [ ] Step 2: 原因切り分け — DevTools の Event Listeners で xterm scrollbar の `pointerdown` を確認し、React Flow の drag handler が先に capture していないか / `pointer-events: none` がかかっていないかを判定
- [ ] Step 3: 修正方針 A — TerminalCard 側の terminal wrapper に `nodrag` クラスを付与 (1 行追加)。これだけで解消すればここで止める
- [ ] Step 4: 修正方針 B (A で不十分なら) — `canvas.css` 側のセレクタを TerminalCard まで拡張 (`pointer-events: auto !important` を統一)
- [ ] Step 5: 修正方針 C (それでも不十分なら) — `CardFrame` の `onPointerDown` で `target.closest('.scrollbar.vertical, .xterm-scrollable-element')` のときだけ `stopPropagation` をスキップ
- [ ] Step 6: Claude / Codex / カスタムエージェント / 通常 Terminal カード の 4 系統で回帰確認

### 検証方法
- `npm run typecheck` が通る
- `npm run dev` で起動し、Canvas モードに切替 → Claude / Codex / Terminal カードを並べて全て立ち上げ、scrollbar thumb をマウスでドラッグできることを目視確認
- マウスホイールスクロールが従来通り効く (regression なし)
- カードを通常通りドラッグで移動できる (scrollbar 領域以外は drag が React Flow に届く)
- 通常 IDE モードの Terminal タブでも regression が無い

### リスク・代替案
- リスク: `nodrag` を広く当てすぎるとカード本体のドラッグ移動が効かなくなる。あくまで scrollbar / xterm-scrollable-element 配下に限定する
- リスク: `pointer-events: auto !important` を強める方向は、別の overlay (`Handle` 等) との重なりを潰す可能性があるので影響範囲を最小化する
- 代替案: xterm の `scrollbar` を OS ネイティブに切り替える方向はライブラリ仕様上難しいので採用しない

### 想定 PR 構成
- branch: `fix/issue-327-codex-terminal-scrollbar`
- commit 粒度: 1 commit (Step 3 の最小修正で済む想定。Step 4/5 が必要になったら 2〜3 commit に分割)
- PR title 案: `fix(canvas): #327 Codex ターミナルでスクロールバーをマウス操作できない問題を修正`
- 本文に `Closes #327` を含める
