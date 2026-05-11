## 実装計画

### ゴール
`team_send` の戻り値に「配送 (delivered) と読了 (read) の状態」を機械的に区別できるレスポンスを持たせ、Leader が「送ったから着手しているはず」と誤解する余地を構造的に消す。既に内部では `delivered_to` / `read_by` が分離されているので、それを team_send 応答と diagnostics の 1 等市民にする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/send.rs` — レスポンス JSON に `delivery_status: { delivered: [...], pending: [...], read_so_far: [...] }` を含めて返す (現状は delivered_to の集計のみ)
- `src-tauri/src/team_hub/protocol/tools/diagnostics.rs` — `pending_inbox_summary` と `stalledInbound` (60s) の lift。worker ごとの「unread かつ delivered からの経過秒数」を表面化
- `src/types/shared.ts` — TeamHub レスポンス型を更新
- `src/renderer/src/components/canvas/AgentNodeCard/CardFrame.tsx` — agent カードに「unread badge」「pending inbox count」を表示
- `.claude/skills/vibe-team/SKILL.md` — Leader 行動規約に「team_send 後は delivery_status を必ず確認 → 未読が 60s 以上なら team_read 督促」を追記

### 実装ステップ
- [ ] Step 1: send.rs のレスポンスを拡張 (互換性: 既存フィールドは残す)
- [ ] Step 2: diagnostics.rs に `unreadAgeSeconds` 派生フィールドを追加
- [ ] Step 3: shared.ts の型同期 (5 点同期 — `tauri-ipc-commands` skill 参照)
- [ ] Step 4: AgentNodeCard に未読バッジ表示。閾値超過で警告色
- [ ] Step 5: skill 側に運用ルール追記
- [ ] テスト: send.rs / diagnostics.rs に既存テストがあれば拡張

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::tools::send`
- `cargo test -p vibe_editor team_hub::protocol::tools::diagnostics`
- `npm run typecheck` / `npm run build`
- 手動: 2 名構成のチームを作り、片方を放置 (= team_read を呼ばない) → Leader 視点で unread badge と diagnostics の `unreadAgeSeconds` が増えるのを確認

### リスク・代替案
- リスク: レスポンス型を拡張すると古い bridge と型ズレ。`tauri-ipc-commands` skill 5 点同期に従う。
- 代替案: bridge.js 側で polling して renderer に push (より重い)。今回はレスポンス拡張で軽量実装。

### 想定 PR 構成
- branch: `enhancement/issue-509-team-send-delivery-status`
- commit 粒度: Rust 1 / TS+UI 1 / skill 1 (合計 3 でも OK、1 にまとめても OK)
- PR title: `enhancement(vibe-team): team_send に delivery_status と unread age を露出して読了確認 UX を強化`
- 本文に `Closes #509`、関連 #510 / #524 を記載
