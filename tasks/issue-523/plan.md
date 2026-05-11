## 実装計画

### ゴール
worker の「指示待ち厳守」と「自律判断」のバランスを worker 単位で設定可能にし、Leader が pre-approval (軽量補足調査の事前許可) を発行できる仕組みを skill / プロトコルレベルで提供する。

### 影響範囲 / 触るファイル
- `src/types/shared.ts` — `WaitPolicy = "strict" | "standard" | "proactive"`、`TaskPreApproval { allowed_actions: string[] }` を追加
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — recruit に `wait_policy` を追加
- `src-tauri/src/team_hub/protocol/tools/assign_task.rs` — task に `pre_approval` を添付できるように
- `src/renderer/src/lib/role-profiles-builtin.ts` — WORKER_TEMPLATE を policy 別 (strict / standard / proactive) で出し分け
- `.claude/skills/vibe-team/SKILL.md` — worker 行動規約に「policy 別の振る舞い」「pre_approval の挙動」「提案モード (実行しない)」を明示

### 実装ステップ
- [ ] Step 1: shared.ts と Rust 引数の同期
- [ ] Step 2: WORKER_TEMPLATE を policy で切替 (composeWorkerProfile に policy 引数追加)
- [ ] Step 3: skill の運用ガイドラインを更新
- [ ] Step 4: UI (Leader 採用ダイアログ) で policy を選択可能に (任意)
- [ ] テスト: WORKER_TEMPLATE の出し分けユニットテスト

### 検証方法
- `cargo test` / `npm run typecheck`
- 手動: proactive worker が「次に何が必要か」を Leader に提案するが実行はしないシナリオを確認 / strict は提案も控えめになる

### リスク・代替案
- リスク: proactive 化で暴走するリスク。実行ではなく「提案のみ」を厳守させる文言を絶対ルール化。
- 代替案: policy を導入せず単一仕様で固定 (現状)。タスクの規模差に対応できないため policy 化を採用。

### 想定 PR 構成
- branch: `enhancement/issue-523-wait-policy`
- commit 粒度: 1 commit
- PR title: `enhancement(vibe-team): worker の wait_policy と task pre_approval を導入し指示待ち⇄自律のバランスを再設計`
- 本文に `Closes #523`
