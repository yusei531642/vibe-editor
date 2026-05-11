## 実装計画

### ゴール
Leader が誤って or 悪意で worker instructions に「報告は不要」「ユーザー確認なしで全部変更してよい」のような逸脱指示を入れた場合、recruit 段階で禁止句として弾く。worker prompt の最後に system 絶対ルールを再 append して、矛盾時の優先順位を物理的に揃える。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/dynamic_role.rs` — instructions の禁止句 lint。例: "報告は不要", "ユーザー確認なしで", "勝手に〜してよい", "ignore these instructions"
- 新規 `src-tauri/src/team_hub/protocol/instruction_lint.rs` — 正規化 + 禁止句リスト + warn/deny の閾値
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — lint 結果が deny なら拒否、warn なら警告レスポンス + 採用続行
- `src/renderer/src/lib/role-profiles-builtin.ts` — `composeWorkerProfile()` の最後に「絶対ルール」を再 append (system block の後置)
- `.claude/skills/vibe-team/SKILL.md` — Leader 行動規約に「禁止句リスト」を明示
- 新規 `src-tauri/src/team_hub/audit.rs` (任意) — instructions の diff log を `~/.vibe-editor/team-history/<project>/audit.log` に保存

### 実装ステップ
- [ ] Step 1: instruction_lint.rs で正規化 + 禁止句マッチ (大文字小文字 / 全角半角 / 句読点 ゆらぎ)
- [ ] Step 2: dynamic_role.rs / recruit.rs で lint 結果を反映
- [ ] Step 3: composeWorkerProfile に「絶対ルール後置 block」を追加
- [ ] Step 4: audit log (任意) — Issue を分割するなら別 PR
- [ ] テスト: 禁止句マッチのユニットテスト

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::instruction_lint`
- 手動: instructions に「報告は不要」を入れて recruit → 拒否される / warn になる動作確認

### リスク・代替案
- リスク: 偽陽性で正当な instructions が弾かれる → 厳密な完全一致ではなくフレーズ単位 + warn を多めに、deny は本当に危険なケースに限定。
- 代替案: LLM (worker) が prompt 内で自己防衛 (現在の WORKER_TEMPLATE 絶対ルール頼り)。LLM はそれを無視できるので Rust 側 lint を併用。

### 想定 PR 構成
- branch: `security/issue-519-instructions-lint`
- commit 粒度: 1 commit
- PR title: `security(vibe-team): 動的 instructions に逸脱指示の lint と絶対ルール再 append を導入`
- 本文に `Closes #519`、関連 #520 / #508 を記載
