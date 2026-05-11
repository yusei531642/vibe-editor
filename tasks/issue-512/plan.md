## 実装計画

### ゴール
team_send / team_recruit / team_assign_task で SOFT_PAYLOAD_LIMIT (32KiB) を超える長文を送ろうとしたときに、silent truncate ではなく「自動でファイル退避 + 要約 + 添付パス通知」に分流する UX を Hub 側に実装し、Leader / HR / worker の運用知識に依存せず安全に長文が流れるようにする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/send.rs` — payload が SOFT_PAYLOAD_LIMIT 超過時の自動 spool 化 (今は error)
- `src-tauri/src/team_hub/protocol/tools/assign_task.rs` — description が大きい場合も同様の自動 spool 化
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — instructions が MAX_DYNAMIC_INSTRUCTIONS_LEN (16KiB) 超過時の挙動を明示エラーに統一 (recruit は spool 不向き)
- 新規 `src-tauri/src/team_hub/spool.rs` — `.vibe-team/tmp/<short_id>.md` への書き込み / cleanup TTL
- `src-tauri/src/team_hub/protocol/consts.rs` — SPOOL_TTL_HOURS, SPOOL_DIR
- `.claude/skills/vibe-team/SKILL.md` — worker テンプレに「メッセージ末尾の `attached: <path>` は必ず読み込む」ルールを強制
- `src/renderer/src/lib/role-profiles-builtin.ts` — WORKER_TEMPLATE に同上を追記

### 実装ステップ
- [ ] Step 1: spool.rs を新規追加 (write_spool / cleanup_old_spools)
- [ ] Step 2: send.rs / assign_task.rs で payload > SOFT_PAYLOAD_LIMIT 時に spool → 注入本文は要約 + パスのみ
- [ ] Step 3: cleanup タスク (TeamHub start 時 + 定期) を mod.rs に追加
- [ ] Step 4: worker テンプレに添付読み込みルール
- [ ] テスト: spool ライフサイクル / 32KiB 超過の自動分流テスト

### 検証方法
- `cargo test -p vibe_editor team_hub::spool`
- `cargo test -p vibe_editor team_hub::protocol::tools::send` (新規シナリオ)
- 手動: 50KiB 程度のメッセージを team_send で送り、worker の inbox に「summary + attached: <path>」だけが届き、ファイル本体は spool ディレクトリに存在することを確認

### リスク・代替案
- リスク: spool ファイルが残り続ける → TTL cleanup 必須。TeamHub 終了時にも cleanup。
- リスク: worker がパスを読み込まずに要約だけで作業 → skill / WORKER_TEMPLATE で明示強制。
- 代替案: chunk 分割で逐次送信 (TUI 側の paste 順序保証が必要、複雑)。spool 方式を採用。

### 想定 PR 構成
- branch: `enhancement/issue-512-auto-spool-large-payload`
- commit 粒度: Rust 1 / skill+template 1 (合計 2)
- PR title: `enhancement(vibe-team): 32KiB 超のメッセージ / タスクを自動 spool 化して fail-loud から安全分流に切替`
- 本文に `Closes #512`、関連 #509 / #511 を記載
