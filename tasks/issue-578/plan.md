## 実装計画

### ゴール
Canvas が非アクティブ (`document.visibilityState === 'hidden'` または Tauri Window がフォーカス外) の状態で `team:recruit-request` が emit された場合、可視化された瞬間に Toast で「Canvas を非表示の間にメンバー採用が走りました。失敗していたら再実行してください」を 1 度だけ表示する。同時に Hub 側にも観測用 event を送り、ログ集計で「非アクティブ中採用」の頻度を可視化できるようにする。

### 影響範囲 / 触るファイル
- `src/renderer/src/lib/use-recruit-listener.ts`
  - `team:recruit-request` 受信時に「現在 visibilityState が hidden / window unfocused か」を判定し、フラグ (zustand or local ref) に積む。
  - 可視化された瞬間に積まれていた件数を取り出して Toast 表示 → flush。
- `src/renderer/src/App.tsx`
  - `document.addEventListener('visibilitychange', ...)` をトップレベルで mount する場所が無ければここに追加。Tauri 2 の `@tauri-apps/api/window` から `getCurrentWindow().onFocusChanged(...)` も併用。
  - 既存の `useRecruitListener` 呼び出し直下に visibility/focus 監視 hook を mount。
- `src/renderer/src/lib/use-canvas-visibility.ts` (新規)
  - `document.visibilityState` + Tauri window focus を統合した hook。返り値: `{ isCanvasVisible: boolean; subscribeOnVisible: (cb) => unsubscribe }`。
- `src/renderer/src/lib/toast-context.tsx` — 既存の Toast Context をそのまま流用 (新規実装不要)。
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` (該当時)
  - 観測強化: renderer 側から `app_recruit_observed_while_hidden` のような IPC コマンドを叩いてもらい、Hub 側で `tracing::info!("[teamhub] recruit while canvas hidden ...")` を吐くだけの軽量 endpoint を追加。Issue 本文の「5 秒以上 hidden が続いている時」条件は renderer 側で判定して Hub に通知する。
- `src-tauri/src/commands/team.rs` (新規 IPC コマンド先) — 新規 `recruit_observed_while_hidden(team_id, agent_id, hidden_for_ms)` を追加。
- `src/types/shared.ts` — 上記 IPC の引数型を追加。
- `src/renderer/src/lib/tauri-api.ts` — wrapper を追加。
- `src-tauri/src/lib.rs` — `invoke_handler!` に登録。
- `src-tauri/src/commands/mod.rs` — モジュール宣言。
- (テスト) `src/renderer/src/lib/__tests__/use-canvas-visibility.test.ts` (新規) — visibility 変化のシミュレーションで Toast が 1 回だけ出ることを確認。

### 実装ステップ
- [ ] Step 1: `use-canvas-visibility.ts` (新規 hook) を作成。`document.visibilityState` 変化と Tauri Window focus 変化を購読、統合フラグ `isCanvasVisible` を返す。
- [ ] Step 2: `use-recruit-listener.ts` を改修。`team:recruit-request` 受信時に `!isCanvasVisible` なら local ref に積む。`isCanvasVisible` が true に切り替わった瞬間に積まれていた件数を取り出して Toast Context で 1 回通知 + flush。
- [ ] Step 3: 観測 IPC コマンド `recruit_observed_while_hidden` を追加。`tauri-ipc-commands` skill の **5 点同期チェック** を実施 (shared.ts / commands/team.rs / commands/mod.rs / lib.rs invoke_handler / tauri-api.ts wrapper)。
- [ ] Step 4: hidden 経過時間が 5000 ms 以上の状態で recruit を受けた場合のみ、上記 IPC を呼ぶ (短時間の hidden は無視して info ログ汚染を防ぐ)。
- [ ] Step 5: 単体テスト追加 — visibilitychange を `Object.defineProperty(document, 'visibilityState', ...)` で差し替え、Toast が 1 回だけ出ることを vitest で確認。多重表示しないこと、可視化前に複数件積まれても Toast 1 回にまとめられること。
- [ ] Step 6: 既存テスト (`canvas-recruit-focus.test.ts` 系) が壊れていないこと、特に focus 制御との相互作用を確認。

### 検証方法
- `npm run typecheck`
- `npm run test` (vitest 該当ファイル)
- `npm run build`
- 手動回帰: 
  - (a) Canvas を別 window に隠す → HR で 6 体 recruit → 全件成功なら Toast 不要 / 1 件でも失敗 (#574 系) があれば Toast 表示で気付ける
  - (b) Canvas をフォーカスしたまま recruit → Toast は出ない
  - (c) hidden → 即可視化 (1 秒未満) でも Toast が出る (件数があれば)
  - (d) hidden 5 秒以上 + recruit → tracing ログに `recruit while canvas hidden` が出る

### リスク・代替案
- リスク 1: Tauri 2 の `onFocusChanged` がプラットフォーム差で発火タイミングが変わる。→ `document.visibilityState` を主、Tauri focus を補助にして両方の OR で判定。
- リスク 2: Toast が連発される。→ 可視化遷移までに積まれた全件を 1 つの Toast にまとめる (件数を表示)。
- リスク 3: 5s 閾値が短すぎ / 長すぎ。→ env 変数 `VIBE_TEAM_RECRUIT_HIDDEN_THRESHOLD_MS` で調整可能にする (デフォルト 5000)。
- 代替案: Toast ではなく ActivityPanel に「採用 (バックグラウンド)」を 1 行追加する案 → Toast の方が即時性が高い。両方出すのは情報過多なので Toast のみ採用。

### 想定 PR 構成
- branch: `feat/issue-578-canvas-hidden-recruit-warning`
- commit 粒度: 2 commit に分けると整理しやすい
  1. `feat(canvas): #578 visibility hook 追加 + recruit 受信時に hidden 検出して Toast`
  2. `feat(teamhub): #578 hidden 中 recruit 観測 IPC 追加`
  まとめても可 (差分が小さければ 1 commit)。
- PR title 案: `feat(canvas): #578 Canvas 非アクティブ中の recruit を Toast で気付かせる`
- 本文に `Closes #578` を含める。`Refs #574` も併記。
- 依存関係: #576 / #577 とは独立。先行 merge 可能。
