## 実装計画

### ゴール
team レベルの engine policy (claude-only / codex-only / mixed-allowed) を構造化フィールドとして保持し、Leader / HR が `team_recruit` で policy に反する engine を指定したときに Hub 側でハード拒否する。HR 経由の採用で Codex 指定が消えて Claude にリセットされる事故を構造的に消す。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/mod.rs` — `TeamInfo` に `engine_policy: EnginePolicy { kind: ClaudeOnly | CodexOnly | MixedAllowed, default_engine }` を追加
- `src-tauri/src/team_hub/protocol/tools/create_leader.rs` — チーム作成時に policy を引数で受け取り保存
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — engine 指定が policy に反する場合は `recruit_engine_policy_violation` エラー
- `src-tauri/src/team_hub/protocol/tools/info.rs` — info レスポンスに policy を含める (UI / HR が参照)
- `src/types/shared.ts` — TeamInfo / CreateLeaderArgs / RecruitArgs に engine_policy 追加
- `src/renderer/src/components/canvas/AgentNodeCard/CardFrame.tsx` — Leader カードに policy バッジ表示
- `.claude/skills/vibe-team/SKILL.md` — HR / Leader 行動規約に「engine_policy を必ず尊重 / 省略時は team の default_engine」を強制

### 実装ステップ
- [ ] Step 1: shared.ts と Rust 構造体で 5 点同期 (`tauri-ipc-commands` skill 参照)
- [ ] Step 2: create_leader.rs / recruit.rs で policy 検証
- [ ] Step 3: info.rs で policy 露出
- [ ] Step 4: UI バッジ + HR / Leader instructions に policy 尊重ルール
- [ ] テスト: policy 違反 recruit が拒否されるテスト

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::tools::recruit`
- 手動: codex-only でチームを作成 → Leader が engine="claude" で recruit を試みる → 拒否されること

### リスク・代替案
- リスク: 既存の team-history 復元時に policy フィールドが無くて壊れる → migration: 無ければ `mixed-allowed` 扱い。
- 代替案: skill 側 prompt のみで強制 (現状)。LLM が無視する事故が現に起きているため Rust 側強制が必須。

### 想定 PR 構成
- branch: `fix/issue-518-team-engine-policy`
- commit 粒度: 1 commit
- PR title: `fix(vibe-team): team レベル engine_policy を導入し HR 経由採用での engine リセットを防止`
- 本文に `Closes #518`
