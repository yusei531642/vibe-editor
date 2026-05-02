# vibe-team Skills Pack

vibe-editor のキャンバスで GitHub Issue の **計画→実装→レビュー→検証** をチーム組織としてオーケストレーションするスキルセット。

Leader を中心に、動的にワーカーを採用・解散しながら、Issue のライフサイクル全体を vibe-editor 上で視覚的に管理できます。

## インストール

### Windows (PowerShell)
```powershell
cd skills
.\install.ps1
```

### Mac / Linux
```bash
cd skills
chmod +x install.sh
./install.sh
```

### 手動インストール
`vibe-shared-roles/`, `vibe-issue-planner/`, `vibe-autopilot-batch/`, `vibe-fortress-review/`, `vibe-fortress-implement/` の5ディレクトリを `~/.claude/skills/` にコピーしてください。

## 含まれるスキル

| スキル | トリガー | 説明 |
|---|---|---|
| **vibe-shared-roles** | （他スキルから参照） | 19ロールの共通定義。全vibeスキルが採用時に参照する |
| **vibe-issue-planner** | `vibeで計画`, `vibe-issue-planner` | GitHub Issue を並列分析し、実装計画を自動投稿 |
| **vibe-autopilot-batch** | `vibeでバッチ実装`, `vibe-autopilot-batch` | planned ラベル付き Issue を順次自律実装 |
| **vibe-fortress-review** | `vibeでレビュー`, `vibe-fortress-review` | 実装リスクを Tier 判定し、多角レビューを実行 |
| **vibe-fortress-implement** | `vibeで要塞実装`, `vibe-fortress-implement` | Slice & Prove 方式の多重防御実装 |

## スキル間連携

```
vibe-issue-planner → (planned ラベル + Tier判定)
    ↓
vibe-autopilot-batch
    ├→ vibe-fortress-review  (Tier A: --auto-gate)
    └→ vibe-fortress-implement (I2+: --auto)

全スキル共通ロール定義 ← vibe-shared-roles
```

## 必須要件

- [Claude Code](https://claude.ai/claude-code) (CLI / Desktop / Web)
- [vibe-editor](https://github.com/yusei531642/vibe-editor) + vibe-team MCP サーバー

## オプション（なくても動作します）

| 機能 | 必要なもの | 未設定時の動作 |
|---|---|---|
| 外部LLM補助分析 | OpenRouter API キー (`OPENROUTER_API_KEY`) | Claude サブエージェントで代替、またはスキップ |
| ユーザー判断基準 | judgment-policy スキル | 都度ユーザーに確認 |
| 設計レビューチェック | design-review-checklist スキル | チェックをスキップ |
| Issue 命名規則 | issue-naming スキル | デフォルト命名を使用 |

## 組織設計の特徴

- **7±2 ルール**: 1つの Supervisor が管理するのは最大 7±2 体。超えたら Sub-leader を挟む
- **Role Card 超詳細化**: 全ロールの instructions に「期待出力形式」「責任範囲」「判断基準」「完了条件」を明記
- **稟議型 Human Gate**: AI が提案→人間が最終責任を持つパターンを採用
- **State Keeper**: JSON 状態管理の専任ロール（SSoT 一元管理）
- **Risk Scorer**: 15シグナル Tier 判定を一元化（スキル間で再計算不要）

## ライセンス

MIT
