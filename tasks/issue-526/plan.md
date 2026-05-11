## 実装計画

### ゴール
複数 worker が同じファイルを編集して silent overwrite するのを防ぐため、`team_assign_task` に「触る予定のファイル / ディレクトリ」宣言を導入し、TeamHub が同時編集を検知して advisory warning を返す。さらに worker が編集する直前に advisory lock を取得する経路を提供する。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/assign_task.rs` — `target_paths: string[]` 引数を追加 (任意)
- 新規 `src-tauri/src/team_hub/file_locks.rs` — agent_id × path のロック表 (in-memory)、競合検知
- 新規 MCP tool: `team_acquire_file_lock` / `team_release_file_lock` — worker が edit 前後で呼ぶ (advisory)
- `src-tauri/src/team_hub/protocol/tools/mod.rs` — dispatch
- `src/types/shared.ts` — 関連型追加
- `src/renderer/src/lib/role-profiles-builtin.ts` — WORKER_TEMPLATE に「Edit/Write 前に advisory lock を取得 / 終わったら release」を追加
- `.claude/skills/vibe-team/SKILL.md` — 同上を明記
- `src/renderer/src/components/canvas/StageHud.tsx` (任意) — どの worker が何のファイルを触っているかを可視化

### 実装ステップ
- [ ] Step 1: file_locks.rs (HashMap<path, agent_id> + 取得・解放・peek)
- [ ] Step 2: assign_task で target_paths 重複検知 (warning)
- [ ] Step 3: 新規 acquire/release tool + worker テンプレ更新
- [ ] Step 4: UI で lock 状況可視化 (任意 / 別 PR でも OK)
- [ ] テスト: lock の取得 / 競合 / TTL のユニットテスト

### 検証方法
- `cargo test -p vibe_editor team_hub::file_locks`
- 手動: 2 名 worker に同一ファイルを target_paths に含むタスクを assign → warning が返ることを確認 / acquire 競合時に拒否されること

### リスク・代替案
- リスク: advisory なので worker が呼ばないとロックされない。WORKER_TEMPLATE で強制 + skill で再強調。
- 代替案: ハードロック (filesystem 側に lock file を作る) — クロスプロセス信頼性は上がるが実装重・ゴミファイル懸念。今回は in-memory advisory を採用。

### 想定 PR 構成
- branch: `fix/issue-526-file-locks-advisory`
- commit 粒度: Rust 1 / template+skill 1 (合計 2)
- PR title: `fix(vibe-team): worker のファイル編集衝突を assign_task 宣言と advisory lock で検知`
- 本文に `Closes #526`
