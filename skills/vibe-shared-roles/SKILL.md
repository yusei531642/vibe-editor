---
name: vibe-shared-roles
description: |
  vibe-team版スキル群の共通ロール定義。各vibeスキル（vibe-issue-planner,
  vibe-autopilot-batch, vibe-fortress-review, vibe-fortress-implement）が
  ワーカー採用時に参照する一元管理リファレンス。
---

# vibe-shared-roles

## 概要

4つのvibe-teamスキルで共通利用するワーカーロール定義を一元管理するスキル。
各スキルは起動時にこのSKILL.mdを動的Readし、必要なロールの instructions を取得して
`team_recruit` に渡す。

### 対象スキル

| スキル | 略称 | 主な用途 |
|--------|------|---------|
| vibe-issue-planner | VIP | 全オープンIssueの並列分析・実装計画作成 |
| vibe-autopilot-batch | VAB | Issue バッチ自律実装 |
| vibe-fortress-review | VFR | 動的多角レビュー（Tier A/B/C） |
| vibe-fortress-implement | VFI | Slice & Prove 多重防御実装 |

---

## 共通ロール一覧（ビルトイン3 + カスタム16 = 19ロール）

### ビルトインロール（vibe-team標準 — 3ロール）

vibe-team MCP が内部で自動管理するロール。`references/role-instructions/` にファイルを**作成しない**。
`team_recruit` の対象外であり、vibe-team 起動時に自動的に存在する。

| # | role_id | label | engine | description |
|---|---------|-------|--------|-------------|
| 1 | leader | リーダー | claude | チーム統括・タスク割り振り・最終判断 |
| 2 | hr | 人事 | claude | 大量採用の代行 |
| 3 | skill_architect | Skill Architect | claude | スキル設計・共通基盤作成 |

### カスタムロール（本スキルで定義 — 16ロール）

| # | role_id | label | engine | description | 使用スキル |
|---|---------|-------|--------|-------------|-----------|
| 4 | state_keeper | 状態管理者 | codex | JSON状態管理・claim・resume | VAB, VFI |
| 5 | risk_scorer | リスク判定者 | codex | 15シグナルTier判定 | VFR, VFI |
| 6 | codex_scout | 偵察員 | codex | 軽量事前調査・概要収集 | VIP, VAB |
| 7 | codex_analyzer | 精密分析者 | codex | コード精密分析・影響範囲走査 | VFR, VFI |
| 8 | codex_final_checker | 最終検証者 | codex | 実装後の最終品質チェック | VFI, VAB |
| 9 | reviewer_tech | 技術レビュアー | claude | 技術正確性・ロジック検証 | VFR |
| 10 | reviewer_arch | 設計レビュアー | claude | アーキテクチャ適合性・設計原則 | VFR |
| 11 | reviewer_devil | 悪魔の代弁者 | claude | 反論・見落とし・最悪ケース指摘 | VFR |
| 12 | reviewer_security | セキュリティ審査官 | codex | セキュリティ脆弱性の網羅的検出 | VFR |
| 13 | reviewer_scenario | 障害シナリオ評価者 | claude | 本番障害シナリオの洗い出し・評価 | VFR, VFI |
| 14 | implementer | 実装者 | claude | 単一Issue実装（計画→コード→テスト） | VAB, VIP |
| 15 | slice_implementer | Slice実装者 | claude | Slice単位の最小差分実装 | VFI |
| 16 | cross_checker | クロスチェッカー | codex | 実装者とは別視点でのコード検証 | VFI |
| 17 | nver_implementer | N-version実装者 | codex | 重要ロジックの独立再実装（投票用） | VFI |
| 18 | e2e_tester | E2Eテスター | claude | ブラウザE2Eテスト実行・検証 | VFI, VAB |
| 19 | external_llm_synthesizer | 外部LLM補助分析者 | claude | 外部LLM API（OpenRouter等）による補助分析の統合 | VIP |

---

## ロール設計原則

### 1. 7±2 ルール
1つの Supervisor（Leader）が直接管理するワーカーは最大 7±2 体。
8体を超える場合は Sub-leader を挟んでスパンを管理する。

### 2. Role Card 超詳細化
各ロールの instructions に以下5項目を必ず明記する:

| 項目 | 内容 | 例 |
|------|------|-----|
| 【あなたの役割】 | 1-2文の役割説明 | 「15シグナルで実装リスクをスコアリングする」 |
| 【期待出力形式】 | 具体的フォーマット | JSON / Markdownテーブル / チェックリスト |
| 【責任範囲】 | やること・やらないこと | 「判定はするが修正はしない」 |
| 【判断基準】 | 迷ったときのルール | judgment-policy参照 / 安全側に倒す |
| 【完了条件】 | 何をもって完了か | 「全項目にスコアを付けて報告」 |

### 3. 稟議型 Human Gate
AIが提案→人間が最終責任を持つパターンを全スキルで採用。
CRITICAL判定は必ずユーザー承認を経由させる。

### 4. エンジン固定原則
各ロールの engine は本スキルの一覧テーブルで固定。
呼び出し側スキルが勝手に変更しない。

---

## エンジン選択ガイドライン

| engine | 得意分野 | 選定理由 |
|--------|---------|---------|
| **claude** | コーディング、長文推論、ファイル操作、git操作、設計判断 | 汎用性最高。迷ったらこれ |
| **codex** | セカンドオピニオン、網羅的走査、read-only分析、影響範囲列挙 | 別視点を入れたいとき |

### codex 選定の具体的基準

- 実装者（claude）と**別の視点**でコードを検証したい → codex
- ファイル全件 grep して影響範囲を**網羅的に**列挙したい → codex
- JSON状態ファイルの**機械的な**読み書き → codex
- 抽象的な設計判断・複雑なリファクタ → claude

---

## 依存スキル埋め込みマトリクス

各ロールの instructions に埋め込むべきスキルルールの対応表。
`○` = 全文埋め込み、`△` = クイック版埋め込み、`-` = 不要。

ビルトイン3ロール（leader, hr, skill_architect）は vibe-team が内部管理するため本マトリクスの対象外。

| role_id | judgment-policy | fortress-review | fortress-implement | design-review | issue-naming | issue-flow |
|---------|:-:|:-:|:-:|:-:|:-:|:-:|
| state_keeper | △ | - | △ | - | - | - |
| risk_scorer | △ | ○(Tier判定) | ○(Tier判定) | - | - | - |
| codex_scout | △ | - | - | - | - | △ |
| codex_analyzer | △ | △ | △ | - | - | - |
| codex_final_checker | △ | - | △ | - | - | - |
| reviewer_tech | △ | ○(出力形式) | - | △ | - | - |
| reviewer_arch | △ | ○(出力形式) | - | ○(Phase1-2) | - | - |
| reviewer_devil | △ | ○(出力形式) | - | △ | - | - |
| reviewer_security | △ | ○(出力形式) | - | - | - | - |
| reviewer_scenario | △ | ○(出力形式) | △ | △ | - | - |
| implementer | △/抜粋 | - | - | ○ | ○ | ○ |
| slice_implementer | △/抜粋 | - | ○(Phase2) | ○ | - | - |
| cross_checker | △ | △ | △ | - | - | - |
| nver_implementer | △ | - | △(N-ver) | - | - | - |
| e2e_tester | △ | - | △ | - | - | △ |
| external_llm_synthesizer | △ | △ | - | - | △ | - |

凡例:
- `○` = そのスキルの該当セクション全文を instructions に埋め込む
- `△` = `references/judgment-policy-quick.md` のクイック判定表を埋め込む
- `-` = 埋め込み不要

---

## instructions テンプレート

各ロールの詳細 instructions は `references/role-instructions/` 配下を参照。
ビルトイン3ロール（leader, hr, skill_architect）は vibe-team が内部管理するため、このディレクトリには含めない。

### ファイル一覧（カスタム16ロール分）

```
references/role-instructions/
├── state_keeper.md
├── risk_scorer.md
├── codex_scout.md
├── codex_analyzer.md
├── codex_final_checker.md
├── reviewer_tech.md
├── reviewer_arch.md
├── reviewer_devil.md
├── reviewer_security.md
├── reviewer_scenario.md
├── implementer.md
├── slice_implementer.md
├── cross_checker.md
├── nver_implementer.md
├── e2e_tester.md
└── external_llm_synthesizer.md
```

### 32KiB超の場合

instructions が 32KiB を超える場合は `.vibe-team/tmp/<short_id>.md` にファイル書き出し、
`team_recruit` の instructions には「サマリ + ファイルパス」のみを渡す。

---

## 使い方

### 基本フロー

```
1. 呼び出し側スキルが本 SKILL.md を動的 Read
2. 必要なロールの role_id を特定
3. references/role-instructions/<role_id>.md を Read
4. ファイル内容をそのまま team_recruit の instructions に渡す
5. 必要に応じて judgment-policy-quick.md の内容を instructions 末尾に追記
```

### team_recruit 呼び出し例

```javascript
// 1. ロール定義ファイルを Read
const instructions = Read("../vibe-shared-roles/references/role-instructions/risk_scorer.md");
// vibe-team SKILL.md: ../vibe-team/SKILL.md

// 2. team_recruit に渡す
team_recruit({
  role_id: "risk_scorer",
  engine: "codex",
  label: "リスク判定者",
  description: "15シグナルTier判定",
  instructions: instructions
});
```

### 動的カスタマイズ

呼び出し側スキルが、ロール定義ファイルの内容にプロジェクト固有の情報を追記してもよい:

```javascript
const base = Read("../vibe-shared-roles/references/role-instructions/implementer.md");
const custom = base + "\n\n## プロジェクト固有ルール\n- staging経由必須\n- RLSポリシー確認必須";
team_recruit({ role_id: "implementer", engine: "claude", label: "実装者", description: "単一Issue実装（計画→コード→テスト）", instructions: custom });
```

---

## ロール組み合わせパターン（スキル別）

### vibe-issue-planner (VIP)

```
Leader
├── codex_scout x1-3     (Issue事前調査)
├── implementer x1-3     (実装計画作成)
└── external_llm_synthesizer x1  (外部LLM補助分析、条件付き)
```

### vibe-autopilot-batch (VAB)

```
Leader
├── state_keeper x1      (バッチ状態管理)
├── codex_scout x1       (事前調査)
├── implementer x1-5     (Issue実装ワーカー)
├── codex_final_checker x1 (最終検証)
└── e2e_tester x1        (E2Eテスト)
```

### vibe-fortress-review (VFR)

Tier A (5体):
```
Leader
├── risk_scorer x1       (Tier判定)
├── codex_analyzer x2    (影響範囲 + テスト網羅)
├── reviewer_tech x1     (技術正確性)
├── reviewer_arch x1     (アーキテクチャ)
├── reviewer_devil x1    (反論)
├── reviewer_security x1 (セキュリティ)
└── reviewer_scenario x1 (障害シナリオ)
```

Tier B (3体): risk_scorer + codex_analyzer x1 + reviewer_tech + reviewer_scenario
Tier C (2体): risk_scorer + codex_analyzer x1 + reviewer_tech

### vibe-fortress-implement (VFI)

Tier I0-I3 で段階的にロールを追加:
```
Leader
├── risk_scorer x1           (Tier判定)         [I0+]
├── slice_implementer x1     (Slice実装)         [I0+]
├── reviewer_tech x1         (ロジックレビュー)    [I0+]
├── codex_analyzer x1        (影響範囲)          [I1+]
├── codex_final_checker x1   (テスト強化)         [I1+]
├── reviewer_scenario x1     (障害シナリオ)       [I2+]
├── cross_checker x1         (クロスチェック)      [I2+]
├── nver_implementer x1      (N-version実装)     [I3]
├── e2e_tester x1            (E2Eテスト)         [I2+]
└── state_keeper x1          (状態管理)          [I1+]
```

---

## 共通出力フォーマット

### レビュー系ロール共通（FR形式）

全レビューロール（reviewer_*, codex_analyzer）が出力する形式:

```
【検出項目】
- ID: {スキル略称}-{role短縮}-{連番}  (例: VFR-RT-01)
- ファイル: {パス}:{行番号}
- カテゴリ: ARCHITECTURE | LOGIC | SECURITY | DATA_INTEGRITY | REQUIREMENT | OPERATIONAL
- 深刻度: CRITICAL | HIGH | MEDIUM | LOW | INFO
- 判定: PASS | FAIL | WARN
- 問題: {1-2文}
- 根拠: {コードから直接証明可能な事実}
- 修正案: {深刻度HIGH以上の場合のみ}
- 残存リスク: {修正後も残るリスク}

問題なしの場合: 「全項目PASS」と1行で報告。
```

### 状態管理ロール（JSON形式）

state_keeper が管理する状態ファイルの共通スキーマ:

```json
{
  "batch_id": "B-YYYY-MM-DD-N",
  "phase": "planning | implementing | reviewing | testing | completed",
  "issues": [
    {
      "number": 123,
      "status": "pending | claimed | in_progress | completed | failed",
      "claimed_by": "worker_id",
      "claimed_at": "ISO8601"
    }
  ],
  "self_healing_log": []
}
```

---

## judgment-policy クイック版

全ワーカーが参照する判断基準の圧縮版は `references/judgment-policy-quick.md` に配置。
instructions に埋め込む際はこのファイルの内容を末尾に追記する。

---

## 外部スキル依存（オプショナル）

以下のスキルがインストール済みの場合は自動的に参照されます。未インストールでも動作します。
- judgment-policy: ユーザー判断基準（未設定時は都度ユーザーに確認）
- design-review-checklist: 設計レビューチェック（未設定時はスキップ）
- issue-naming: Issue命名規則（未設定時はデフォルト命名）

---

## 改訂履歴

| 日付 | 変更内容 | 契機 |
|------|---------|------|
| 2026-05-02 | 初版作成 | vibe-team版スキル群の共通基盤として新規作成 |
| 2026-05-02 | ビルトイン3ロール明記、JP-09〜11追加、マトリクス修正、パス統一 | Task #8 レビュー指摘対応 |
