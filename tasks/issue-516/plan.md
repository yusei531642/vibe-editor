## 実装計画

### ゴール
複数 worker の成果が Leader 任せで散逸している現状に対し、(1) 成果物を構造化フィールドで返させる、(2)「統合フェーズ」を skill 上で必須ステップとして明示する、(3) 「integrator (統合担当)」のロールテンプレを推奨パターンとして提示する、の 3 点で改善する。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/update_task.rs` — `report_payload` 構造化フィールド (findings / proposal / risks / next_action / artifacts[]) を追加
- `src/types/shared.ts` — UpdateTaskArgs / TaskReport 型を拡張
- `.claude/skills/vibe-team/SKILL.md` — Leader 行動規約に「統合フェーズ」を追加 (収集 → 矛盾抽出 → 優先度判定 → 採用方針)
- `src/renderer/src/lib/role-profiles-builtin.ts` — 推奨ロールテンプレに `integrator` (統合担当) のサンプル instructions を追加 (動的ロール用テンプレ)
- (UI) Canvas 上の Leader カードに「統合チェック (受領 / 矛盾 / 採用)」のチェックリスト表示 (任意)

### 実装ステップ
- [ ] Step 1: update_task.rs の引数を拡張、worker_reports に構造化形式で保存
- [ ] Step 2: shared.ts 同期
- [ ] Step 3: skill 側に統合フェーズの明示
- [ ] Step 4: 推奨 integrator role instructions サンプルを skill に提示
- [ ] テスト: update_task の構造化レポート ラウンドトリップ

### 検証方法
- `cargo test -p vibe_editor team_hub::protocol::tools::update_task`
- `npm run typecheck`
- 手動: 複数 worker から構造化 report を集めて Leader が integrator に渡し、最終提案を 1 つにまとめるシナリオを試す

### リスク・代替案
- リスク: 構造化フィールド必須にすると後方互換性問題。全フィールド optional にし、既存の summary/blocked_reason との重複を避ける。
- 代替案: integrator を builtin 化する。今回は skill / 動的ロールテンプレに留め、運用で評価。

### 想定 PR 構成
- branch: `enhancement/issue-516-result-integration`
- commit 粒度: 1 commit
- PR title: `enhancement(vibe-team): worker 成果の構造化 report と統合フェーズを skill / プロトコルで明示`
- 本文に `Closes #516`、関連 #515 / #525 / #527 を記載
