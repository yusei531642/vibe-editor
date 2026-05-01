# ステータスマスコット スプライト実装計画

## 目的

vibe-editor の配色と控えめな作業用 UI に合わせて、添付スクリーンショットのような小さなピクセル調キャラクターをステータスバーへ追加する。状態に応じて 6 パターンのスプライトを切り替え、エディターの作業状況を邪魔しない範囲で伝える。

## 調査結果

- UI は `src/renderer/src/components/shell/StatusBar.tsx` が下部ステータスバーを描画している。
- ステータスバーの CSS は `src/renderer/src/styles/components/shell.css` に集約されている。
- ターミナル状態は `App.tsx` の `terminalTabs` に `status`, `exited`, `hasActivity` として集約されている。
- PTY の状態文字列は `use-pty-session.ts` から `起動中`, `実行中`, `起動失敗`, `終了`, `例外` として渡される。
- テーマは CSS カスタムプロパティ中心のため、キャラクター色は `--accent`, `--bg-panel`, `--text` 系に寄せる。

## デザイン方針

- visual thesis: Claude 系の温かいコーラルを主色にした、16-bit 風の小さな相棒をステータスバーに置く。
- content plan: ステータスバー左端の現在モード表示に隣接させ、ラベルは増やさず tooltip / aria-label のみで状態を伝える。
- interaction thesis: 通常時は微細な idle motion、作業中は短距離移動、ターミナル実行中はステータスバー内を左右に大きく走らせ、エラー時は短い attention motion に限定する。

## スプライト状態

1. `idle`: プロジェクト選択済みで特別な作業がない状態。
2. `editing`: エディターでファイルを開いている状態。
3. `dirty`: Git 変更がある状態。
4. `running`: Claude/Codex PTY が実行中または起動中の状態。
5. `reviewing`: diff 表示または Canvas モードの状態。
6. `blocked`: PTY 起動失敗・例外・終了済みがある状態。

優先順位は `blocked > running > dirty > reviewing > editing > idle` とする。

## 実装計画

1. GitHub Issue を `enhancement`, `ui` ラベルで作成し、`feature/issue-XXX` ブランチを切る。
2. `StatusMascot.tsx` を新規作成し、6 フレーム横並びの inline SVG sprite sheet と状態判定用型を定義する。
3. `StatusBar.tsx` に `mascotState` props を追加し、左端ステータス表示へ `StatusMascot` を組み込む。
4. `App.tsx` で `terminalTabs`, `gitStatus`, `activeFilePath`, `activeDiffTab`, `viewMode` から mascot state を導出して渡す。
5. `shell.css` または新規 `mascot.css` にサイズ、sprite transform、状態別アニメーション、`prefers-reduced-motion` を追加する。
6. `i18n.ts` に ja/en の aria/tooltip 用ラベルを追加する。
7. 必要に応じて軽量な単体テストを追加する。状態導出を独立関数にできる場合のみ、過剰なテスト分割は避ける。

## レビュー観点

- 初期方針はステータスバーの高さ維持だったが、表示崩れと視認性のユーザーフィードバック後は `--shell-status: 40px` まで広げる。
- `status__item` の既存レイアウトとモバイル非表示ルールを壊さない。
- キャラクターの色は固定画像色にしすぎず、テーマ変数に追従させる。
- SVG は inline にして外部アセット読み込み失敗を避ける。
- `prefers-reduced-motion: reduce` で連続 animation を止める。
- `StatusBar` の props 増加は必要最小限にし、App 側の既存 state を直接深く渡さない。

## 検証計画

- `npm run typecheck`
- `npm run test`
- `npm run dev:vite` で UI 起動
- in-app browser でステータスバー表示、テーマ切替、モバイル幅、ターミナル実行/終了相当の表示を確認
- 可能ならスクリーンショットを残し、実装後に本ファイルへ検証結果を追記

## Next Steps

- ユーザー確認後、Issue 作成とブランチ作成から実装を開始する。
- 実装完了後、本ファイルに「進捗」と「Next Tasks」を追記する。

## 進捗

- GitHub Issue #353 を作成し、`feature/issue-353` ブランチで実装した。
- `StatusMascot.tsx` に 6 フレーム横並びの inline SVG sprite sheet を追加した。
- `idle`, `editing`, `dirty`, `running`, `reviewing`, `blocked` の 6 状態を `getStatusMascotState` で導出し、`App.tsx` から `StatusBar` へ接続した。
- ステータスバー左端のモード表示にマスコットを組み込み、テーマ変数、状態別 animation、`prefers-reduced-motion` を CSS に追加した。
- ja/en の tooltip / aria-label を追加した。
- `filetree-state-context.test.tsx` の Tauri API mock に `setZoomLevel` / `setProjectRoot` を追加し、既存テストの未処理エラーを解消した。
- ユーザーフィードバックを受け、四角い顔型から V 字/カーソル寄りのシルエットへ変更し、ステータスバー内サイズを 16px から 22px に拡大した。
- 22px 拡大時にスプライトシート本体とフレーム移動量が 16px 固定のままだったため、`--mascot-size: 32px` / sheet 192px / 32px offset に揃えて崩れを修正した。
- `StatusBar` に `status__mascot-track` を追加し、状態別に横移動量を変えた。`running` はトラック幅いっぱいを往復、`dirty` / `reviewing` は中距離、`editing` は短距離移動にした。

## 検証結果

- `npm run typecheck`: 成功。
- `npx vitest run src/renderer/src/lib/__tests__/status-mascot.test.ts`: 6 tests 成功。
- デザイン調整後の `npm run typecheck`: 成功。
- デザイン調整後の `npx vitest run src/renderer/src/lib/__tests__/status-mascot.test.ts`: 6 tests 成功。
- `npm run test`: 12 files / 83 tests 成功。既存の jsdom canvas 未実装 warning は出るが終了コードは 0。
- `npm run dev`: Tauri dev profile build 成功、`target\debug\vibe-editor.exe` 起動。ネイティブウィンドウでステータスマスコットがテーマ配色に馴染んで表示されることを確認。
- `npm run build:vite`: 成功。既存の大きい chunk / dynamic import warning のみ。
- 32px 化・横移動追加後の `npm run typecheck`: 成功。
- 32px 化・横移動追加後の `npx vitest run src/renderer/src/lib/__tests__/status-mascot.test.ts`: 6 tests 成功。
- 32px 化・横移動追加後の `git diff --check`: 成功。
- 32px 化・横移動追加後の `npm run build:vite`: 成功。既存の大きい chunk / dynamic import warning のみ。

## レビュー結果

- ステータスバーの高さは、ユーザーフィードバックを優先して 40px に変更した。`grid-template-rows` と activity panel は `--shell-status` 参照のため連動する。
- `StatusBar` には導出済みの `mascotState` のみを渡し、App 側の状態一式は渡していない。
- SVG は外部アセット化せず inline にして、読み込み失敗リスクを避けた。
- animation は CSS のみで、`prefers-reduced-motion: reduce` で停止する。
- 状態判定は単体テストで優先順位を確認した。

## Next Tasks

- 実機利用で横移動の存在感が強すぎる場合は、`--mascot-track-width` または animation duration を微調整する。
- 将来、ステータスバー以外にも表示する場合は、今回の `StatusMascot` を再利用し、状態導出ロジックは増やさない。
