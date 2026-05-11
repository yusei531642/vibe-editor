## 実装計画

### ゴール
動的ロール同士の責務境界を `team_recruit` / `team_assign_task` の段階で機械的に検出し、同質ロールの重複や領域重複を Leader / HR が無自覚に量産することを防ぐ。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — 採用時に既存メンバーのロール label / description / instructions の類似度を計算し、閾値超過なら warning を返す
- `src-tauri/src/team_hub/protocol/tools/assign_task.rs` — タスク割り振り時、宛先 worker と他 worker の責務範囲が同領域 (キーワード) なら warning
- 新規 `src-tauri/src/team_hub/role_lint.rs` — 軽量類似度 (Jaccard / トークン重複率) と禁止キーワード ("汎用", "support", "general", "何でも")
- `src/renderer/src/components/canvas/StageHud.tsx` — 警告 badge / トースト
- `.claude/skills/vibe-team/SKILL.md` — Leader 採用前チェック (調査 / 実装 / 検証 / レビュー / 統合 の 5 軸ばらけ判定)

### 実装ステップ
- [ ] Step 1: role_lint.rs を新規追加 (text 正規化 + 簡易類似度)
- [ ] Step 2: recruit.rs / assign_task.rs に lint 呼び出し、warning レスポンス追加
- [ ] Step 3: UI で warning を可視化 (採用ダイアログ等で表示)
- [ ] Step 4: skill 側にも責務マトリクスの推奨パターン記述
- [ ] テスト: 類似度ロジックのユニットテスト

### 検証方法
- `cargo test -p vibe_editor team_hub::role_lint`
- 手動: 「Canvas 調査」「Terminal 調査」「ターミナル文字化け調査」のように似たロールを連続採用して warning が出るか確認

### リスク・代替案
- リスク: 偽陽性で正当な採用を妨げる → warning のみでハード拒否はしない。Leader が確認後 force flag で続行可能に。
- 代替案: LLM 側で判定 (Leader prompt に推論させる)。再現性が低いので Rust 側ヒューリスティックを採用。

### 想定 PR 構成
- branch: `enhancement/issue-517-role-overlap-lint`
- commit 粒度: 1 commit
- PR title: `enhancement(vibe-team): 同質ロール / 重複領域を recruit と assign_task で lint warn`
- 本文に `Closes #517`、関連 #507 / #508 を記載
