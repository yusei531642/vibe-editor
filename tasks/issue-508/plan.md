## 実装計画

### ゴール
動的ロールの instructions が薄かったり責務が曖昧だったりして worker が迷う事態を、`team_recruit` 段階で機械的に弾く。ロール定義の必須テンプレと「曖昧名・抽象名 NG リスト」を Rust 側で検証し、Leader / HR がぶれても worker 品質が一定以上に保たれる状態にする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/dynamic_role.rs` — `validate_and_register_dynamic_role()` に必須項目検証を追加 (responsibilities / inputs / outputs / done_criteria の 4 軸 ≥ 数十バイト)
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — instructions が NG パターン (例: 単独 "general", "support", "何でもやる") の場合 warning を返す
- `src-tauri/src/team_hub/error.rs` — `RecruitError` に `dynamic_role_too_vague` 等のコード追加
- `src/types/shared.ts` — DynamicRoleEntry に validation メタを追加 (任意)
- `.claude/skills/vibe-team/SKILL.md` — 「動的ロール instructions の必須テンプレ」セクション追加
- `src/renderer/src/lib/role-profiles-builtin.ts` — HR 用の Leader 向け案内文に「instructions テンプレ」を埋め込む

### 実装ステップ
- [ ] Step 1: skill / Leader instructions 側に「責務 / 入力 / 出力 / 完了条件」の 4 項目テンプレを定義
- [ ] Step 2: dynamic_role.rs の validate に最低限の構造化検査 (各セクションが 1 行以上存在するか)
- [ ] Step 3: NG ロール名・抽象キーワードの拒否リスト (大文字小文字・日英の正規化込み) を `consts.rs` に定数化
- [ ] Step 4: ユニットテスト追加 (`#[cfg(test)]` for dynamic_role 検証)
- [ ] テスト: vibe_team 既存テスト群 + 新規追加分

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::dynamic_role` (新規テスト含む)
- `npm run typecheck`
- 手動: Leader として `team_recruit` を「曖昧ロール (label="サポート係", instructions=空)」で叩き、エラーで弾かれることを確認

### リスク・代替案
- リスク: 過度に厳しいと熟練 Leader の正当な短縮形まで弾く。warning と error を分離する (lint 段階)。
- 代替案: validation を skill prompt 側だけで行う (Rust 不変)。ただし LLM が無視するリスクがあるので Rust 側強制を推奨。

### 想定 PR 構成
- branch: `enhancement/issue-508-dynamic-role-quality`
- commit 粒度: Rust 側 1 commit + skill 側 1 commit (合計 2)
- PR title: `enhancement(vibe-team): 動的ロール定義に必須テンプレ検証と曖昧名 lint を追加`
- 本文に `Closes #508`、関連 #507 / #511 / #519 を記載
