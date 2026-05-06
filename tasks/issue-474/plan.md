## 実装計画

### ゴール
Canvas モードの「リスト」表示で、各エージェント端末の色・ロール表記・アバターが「ステージ」上の端末カードと同じロールプロファイル由来になるようにする。動的ロール、カスタムロール、組織色つきチームでも、リスト表示だけ既定紫へ落ちない状態を完了条件にする。

### 調査メモ / 根本原因
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` は `payload.roleProfileId ?? payload.role` を使い、`useRoleProfiles().byId` から `profile.visual.color` と `profile.visual.glyph` を解決している。
- `src/renderer/src/components/canvas/Canvas.tsx` の `StageListOverlay` は `payload.role` のみを読み、互換 shim の `colorOf(payload?.role)` を使っている。
- `colorOf()` は `src/renderer/src/lib/team-roles.ts` の builtin 互換 API で、動的ロールやユーザー定義ロールを解決できず `#7a7afd` に fallback する。
- そのため、ステージ上の `AgentNodeCard` は現在のロールプロファイル色、リスト上の行は旧 builtin 色または fallback 色になり、配色がずれる。

### 影響範囲 / 触るファイル
- `src/renderer/src/components/canvas/Canvas.tsx` — `StageListOverlay` のロール解決を `roleProfileId` 優先 + `RoleProfilesContext` ベースへ変更する。
- `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx` — 必要ならリストと共有できる視覚情報解決 helper を使う形に薄く寄せる。
- `src/renderer/src/lib/agent-visual.ts` (新規候補) — `roleProfileId` / legacy `role` / profile / label / glyph / color / organization color の解決を小さく共通化する。
- `src/renderer/src/lib/__tests__/agent-visual.test.ts` (新規候補) — `roleProfileId` が legacy `role` より優先され、custom/dynamic profile color が使われることを固定する。
- `src/renderer/src/styles/components/canvas.css` — リスト行の CSS 変数を stage 側と同じ意味に揃える。必要に応じて `--agent-accent` / `--organization-accent` を使う。
- `src/renderer/src/styles/__tests__/canvas-css-contract.test.ts` — リスト行が role/profile 色変数を参照する契約を追加する。

### 実装ステップ
- [ ] Step 1: `StageListOverlay` の payload 型を `roleProfileId` / `role` / `organization` 対応にし、`useRoleProfiles` と `profileText` / `fallbackProfile` で `AgentNodeCard` と同じロール表示情報を解決する。
- [ ] Step 2: リスト行に渡す CSS 変数を `--role-color` だけに閉じず、stage 側と同じ `agentAccent` / `organizationAccent` の意味へ揃える。
- [ ] Step 3: 変更が重複する場合は小さな `agent-visual` helper に抽出し、`AgentNodeCard` と `StageListOverlay` から同じ解決ロジックを使う。
- [ ] Step 4: 動的ロール、custom profile、legacy `role` の fallback を単体テストで固定する。
- [ ] Step 5: CSS contract test でリスト行が role/profile 色を使い続けることを固定する。
- [ ] Step 6: Canvas の Stage/List 切替で、同じ端末のロール色・アバター・ロール名が一致することを手動 smoke する。

### 検証方法
- `npm run typecheck`
- `npx vitest run src/renderer/src/lib/__tests__/agent-visual.test.ts src/renderer/src/styles/__tests__/canvas-css-contract.test.ts`
- `npm run test`
- `npm run build:vite`
- 手動テスト: `npm run dev` で Canvas モードを開き、動的ロールまたはカスタムロール色の agent を配置する。HUD の「ステージ」と「リスト」を切り替え、同じ端末のアクセント色・アバター・ロール名が一致することを確認する。

### リスク・代替案
- リスク: `StageListOverlay` が `useRoleProfiles` を読むことで、profile 更新時の再描画が増える。ただし表示対象は list view のみで、影響は限定的。
- リスク: 組織色をどの UI 要素に反映するかを間違えると、role 色との意味が逆転する。stage 側の `--agent-accent` と `--organization-accent` の役割を基準に合わせる。
- 代替案: helper を作らず `Canvas.tsx` に同等ロジックを局所実装する。差分は小さくなるが、同じズレが再発しやすい。

### 想定 PR 構成
- branch: `fix/issue-474-canvas-list-terminal-colors`
- commit 粒度: 1 commit で十分。helper 抽出とテスト追加を同時に含める。
- PR title 案: `fix(canvas): リスト表示の端末配色をステージ表示と揃える`
- 本文に `Closes #474` を含める。

### Next Steps
- 実装フェーズに進む場合は、上記 branch を切って renderer 側の Canvas 表示修正から始める。
- PR 前に typecheck、対象 vitest、全体 test、build:vite、Canvas Stage/List の手動 smoke を実施する。

### 実装進捗

- [x] `src/renderer/src/lib/agent-visual.ts` を追加し、`roleProfileId` 優先、legacy `role` fallback、profile label/glyph/color、organization color の解決を共通化。
- [x] `AgentNodeCard` と `StageListOverlay` を同じ `resolveAgentVisual()` 経由に変更し、Stage/List/MiniMap/handoff edge の色解決を揃えた。
- [x] リスト行 CSS を `--agent-accent` / `--organization-accent` ベースへ変更し、Stage 側の意味と一致させた。
- [x] `agent-visual.test.ts` と `canvas-css-contract.test.ts` で、`roleProfileId` 優先、custom/dynamic profile、legacy fallback、CSS 変数契約を固定。

### 検証結果

- [x] `npm run typecheck`: PASS
- [x] `npx vitest run src/renderer/src/lib/__tests__/agent-visual.test.ts src/renderer/src/styles/__tests__/canvas-css-contract.test.ts`: PASS (2 files / 6 tests)
- [x] `npm run test`: PASS (31 files / 204 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS
- [x] Playwright smoke: `http://127.0.0.1:5175/` に `roleProfileId=hr` / legacy `role=leader` の agent を注入し、Stage と List の両方で agent accent `#22c55e`、organization accent `#0ea5e9`、role label `人事`、glyph `H` を確認。

### Next Tasks

- [ ] PR を作成する場合は本文に `Closes #474` と上記検証結果を記載する。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。
- [ ] 必要に応じて Tauri 実行環境で追加 smoke を行う。Vite 単体 smoke では Tauri API 未注入由来の既存 console error が出る。
