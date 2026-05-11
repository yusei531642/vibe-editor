## 実装計画

### ゴール
worker 同士が `team_send` で「相談 (advisory)」と「依頼 (request)」を区別できるよう meta type を導入し、依頼は Leader を経由 (または Leader に CC) するルートを skill とプロトコルで明示する。Leader が裏チャネル合意を見逃さないようにする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/send.rs` — 引数に `kind: "advisory" | "request" | "report"` を追加 (省略時は advisory)。request の場合は Leader にも自動 CC
- `src-tauri/src/team_hub/protocol/schema.rs` — schema に kind を追加
- `src/types/shared.ts` — TeamSendArgs / TeamMessage 型を更新
- `src/renderer/src/lib/tauri-api.ts` — wrapper の引数追加
- `.claude/skills/vibe-team/SKILL.md` — worker 行動規約に「依頼は kind:'request' を付ける / それは自動的に Leader にも届く」を追記
- `src/renderer/src/lib/role-profiles-builtin.ts` — WORKER_TEMPLATE に同上を反映
- (UI) `AgentNodeCard` などで request / advisory のバッジ表示

### 実装ステップ
- [ ] Step 1: schema / shared.ts に kind を追加 (5 点同期)
- [ ] Step 2: send.rs で kind が "request" の場合 Leader (active_leader_agent_id) も recipient に追加
- [ ] Step 3: skill + WORKER_TEMPLATE に運用ルール追記
- [ ] Step 4: 受信側 UI で kind バッジ表示 (任意)
- [ ] テスト: send.rs に kind 別配送のテスト

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::tools::send`
- `npm run typecheck`
- 手動: worker A → worker B に kind:"request" でメッセージを送り、Leader にも自動的に届く / kind:"advisory" の場合は届かないことを確認

### リスク・代替案
- リスク: Leader inbox が CC で溢れる → 集約は 1 行サマリ + リンクで。
- 代替案: kind を付けずに「Leader 経由のみ許可」に絞る (autonomy が下がる)。advisory を残すほうがバランス良い。

### 想定 PR 構成
- branch: `enhancement/issue-515-team-send-kind`
- commit 粒度: 1 commit (Rust + TS + skill)
- PR title: `enhancement(vibe-team): team_send に kind (advisory/request/report) を追加し依頼は Leader へ自動 CC`
- 本文に `Closes #515`、関連 #517 / #520 を記載
