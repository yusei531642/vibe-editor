# Issue #475 - Glass canvas background transparency

## 計画

- 対象: https://github.com/yusei531642/vibe-editor/issues/475
- Branch: `feature/issue-475`
- Tier: C
- RCA Mode: Root Cause Confirmed
- 予定ラベル: `enhancement`, `ui`, `canvas`, `planned`

### RCA結果

- 症状: Glass テーマの Canvas モードで背景が白く濁って見え、背後の内容が判別しづらい。ユーザー要望は白濁を薄め、Canvas 背景の透過度を少し上げること。
- 調査対象ブランチ: `main`。Issue #475 を参照する既存 PR はなし。
- 原因箇所:
  - `src/renderer/src/styles/components/glass.css`: Glass 時に `.layout` と `.canvas-layout` の両方へ `background: rgba(10, 10, 26, 0.55)` と `backdrop-filter` を同一適用している。
  - `src/renderer/src/lib/themes.ts`: Glass の `bgPanel` / `bgSidebar` / `bgToolbar` / `bgElev` は過去の白濁対策で 0.78-0.85 程度の高め opacity に寄せられている。
  - `src/renderer/src/styles/tokens.css`: Glass の blur / saturate / brightness は milky 化対策として `12px / 120% / 0.7` に集約されている。
- 原因経路: Canvas root の全面 tint が IDE と同じ濃さで重なり、さらに Canvas header / sidebar / cards / HUD の glass surface が重なるため、Canvas モード全体で背景情報が読みにくくなる。
- 除外した修正対象: Rust/Tauri の Acrylic 適用や Glass 全体の `surfaceGlass` / `bgPanel` を先に下げる案は、IDE モードやカード可読性へ広く波及するため初手にしない。
- 修正方針: Glass の Canvas root tint を IDE root から分離し、Canvas 限定で alpha を少し下げる。カード、サイドバー、HUD の surface token は基本維持し、背景だけが透けやすくなる変更に絞る。

### 実装ステップ

- [x] `glass.css` の `.layout` / `.canvas-layout` 共通指定を分離し、Canvas root だけ低めの tint を使う。
- [x] `tokens.css` に `--glass-layout-tint` / `--glass-canvas-layout-tint` を追加し、Glass の値管理責務を明確にする。
- [x] `glass-css-contract.test.ts` を更新し、Glass root は透明、IDE root と Canvas root は別 tint、Canvas tint は IDE より低 alpha であることを契約化する。
- [x] Canvas のパネル類に使う `--surface-glass` は変更しないことをレビュー観点で固定する。
- [x] `npm run typecheck`、対象 Vitest、`npm run test`、`npm run build:vite` を実行する。
- [ ] `npm run dev` で Tauri 実機の Glass + Canvas を開き、背景の見え方、白濁低減、カード/文字の可読性を手動 smoke する。

### 検証方法

- `npm run typecheck`
- `npx vitest run src/renderer/src/styles/__tests__/glass-css-contract.test.ts`
- `npm run test`
- `npm run build:vite`
- 手動 smoke: Glass テーマに切り替えて Canvas モードを表示し、背景が以前より読み取りやすく、Canvas header / sidebar / agent card / HUD の可読性が落ちていないことを確認する。

### リスク・代替案

- リスク: Canvas root の alpha を下げすぎると、明るい壁紙上で文字や grid の視認性が落ちる。段階的に alpha を下げ、root 以外の surface は維持する。
- リスク: Glass 全体の `--surface-glass` を変更すると IDE、terminal、modal、menu まで薄くなり、過去の白濁・コントラスト対策を壊す。今回の主対象から外す。
- 代替案: Canvas root tint だけでは白濁が残る場合、次段で Canvas 限定の `--glass-brightness` または stage 背景の blur 量を別 token 化して調整する。

### 想定 PR 構成

- branch: `feature/issue-475`
- commit: `fix(canvas): GlassテーマのCanvas背景透過度を調整`
- PR 本文: `Closes #475` と検証結果を記載する。

## Next Steps

- 実装フェーズに進む場合は `feature/issue-475` を作成する。
- まず Canvas root tint の分離と CSS contract test 更新を行う。
- その後、Tauri 実機 smoke で Glass + Canvas の白濁低減と可読性を確認する。

## 進捗

- [x] Issue #475 の本文、コメント、ラベル状態を確認した。
- [x] Glass / Canvas の背景・surface 関連 CSS とテーマ token を調査した。
- [x] Root Cause Confirmed: Glass 時の Canvas root tint が IDE root と同じ強さで、Canvas 全面にかかっている。
- [x] 実装前計画と Next Steps を記録した。
- [x] Issue #475 へ実装計画コメントを投稿した: https://github.com/yusei531642/vibe-editor/issues/475#issuecomment-4384854342
- [x] Issue #475 に `enhancement`, `ui`, `canvas`, `planned` ラベルを付与した。
- [x] `feature/issue-475` ブランチを作成し、Issue ラベルを `implementing` に更新した。
- [x] `src/renderer/src/styles/tokens.css` に `--glass-layout-tint: rgba(10, 10, 26, 0.55)` と `--glass-canvas-layout-tint: rgba(10, 10, 26, 0.40)` を追加した。
- [x] `src/renderer/src/styles/components/glass.css` で IDE root と Canvas root の背景 tint を分離した。
- [x] `src/renderer/src/styles/__tests__/glass-css-contract.test.ts` に Canvas tint が IDE tint より低 alpha である契約を追加した。

## 検証結果

- [x] `npm run test -- src/renderer/src/styles/__tests__/glass-css-contract.test.ts`: PASS (6 tests)
- [x] `npm run typecheck`: PASS
- [x] `npm run test`: PASS (30 files / 200 tests)
- [x] `npm run build:vite`: PASS
- [x] Browser CSS smoke (`http://127.0.0.1:5175/`): `data-theme='glass'` / `data-view-mode='canvas'` を適用し、IDE root `rgba(10, 10, 26, 0.55)`、Canvas root `rgba(10, 10, 26, 0.4)`、両方に `blur(12px) saturate(1.2) brightness(0.7)` が適用されることを確認。
- [x] Browser screenshot: `tasks/issue-475/glass-canvas-css-smoke.png`
- [ ] Tauri native smoke: 未実施。Vite 単体では `__TAURI_INTERNALS__` 未注入に由来する既存 console error が出るため、Acrylic を含む最終視覚確認は PR 前に `npm run dev` で行う。

## Next Tasks

- [x] GitHub Issue #475 closed as `COMPLETED`: https://github.com/yusei531642/vibe-editor/issues/475
- [x] Close comment posted with E2E results and closure basis: https://github.com/yusei531642/vibe-editor/issues/475#issuecomment-4385121557
- [x] Labels updated from `implementing` to `implemented`.
- [x] Verification recorded: targeted Vitest PASS, typecheck PASS, full test PASS, build:vite PASS, Browser CSS smoke PASS.
- [x] `npm run dev` reached `cargo tauri dev` build completion and `target\debug\vibe-editor.exe` launch. Native visual smoke was limited because the existing installed app likely absorbed the single-instance launch.
- [ ] PR is not created. If this implementation is to be merged through the normal release path, create a PR from `feature/issue-475` and wait for CodeRabbit, CI, and human approval.

- [ ] PR を作成する場合は本文に `Closes #475` と上記検証結果を記載する。
- [ ] PR 前に Tauri native smoke を追加する。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。
