## 実装計画

### ゴール
タスクの「Definition of Done (DoD)」を `team_assign_task` の構造化フィールドに必須化し、`team_update_task(status="done")` が DoD 未達の場合はハード拒否する。品質ゲート (テスト / 受入 / セキュリティ) が skill / プロトコル両面で素通しされない状態を作る。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/assign_task.rs` — `done_criteria: string[]` (例: ["typecheck pass", "cargo test pass", "manual repro confirmed"]) を必須化 (空でも 1 件以上)
- `src-tauri/src/team_hub/protocol/tools/update_task.rs` — status="done" 時は `done_evidence: { criterion: string, evidence: string }[]` を要求し、未達なら `task_done_evidence_missing` エラー
- `src/types/shared.ts` — TaskAssign / TaskUpdate 型の更新
- `src/renderer/src/lib/role-profiles-builtin.ts` — WORKER_TEMPLATE / Leader instructions に「DoD 必須」「done 報告には evidence を必ず添付」を強制
- `.claude/skills/vibe-team/SKILL.md` — 「品質ゲートロール (tester / reviewer / security-auditor) の標準フロー」を追加
- (UI) Leader 採用ダイアログ / タスク作成フォームで DoD 入力欄

### 実装ステップ
- [ ] Step 1: shared.ts / Rust 構造体の同期
- [ ] Step 2: assign_task で DoD 必須化、空配列なら error
- [ ] Step 3: update_task で done 時に evidence チェック
- [ ] Step 4: skill 側に標準フロー (assign → 実装 → tester → reviewer → done) を明示
- [ ] Step 5: WORKER_TEMPLATE に done 報告テンプレ追加 (criterion ごとに evidence)
- [ ] テスト: DoD 未達で done に出来ないテスト / 達成済みで done になるテスト

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::tools::update_task`
- 手動: DoD ありのタスクで evidence なしの done 試行が拒否されること / evidence 添付で done になること

### リスク・代替案
- リスク: 既存タスク (DoD 無し) との後方互換 → migration: 古いタスクは done_criteria を空配列扱いにして既存挙動を維持、新規タスクからは必須化を有効化するフラグで段階導入。
- 代替案: skill 規約のみで強制 (現状)。LLM が無視するため Rust 側強制を併用。

### 想定 PR 構成
- branch: `enhancement/issue-527-task-dod-gate`
- commit 粒度: 1 commit
- PR title: `enhancement(vibe-team): タスクに Definition of Done を必須化し done 報告に evidence を要求するハードガードを導入`
- 本文に `Closes #527`、関連 #516 / #524 / #525 を記載
