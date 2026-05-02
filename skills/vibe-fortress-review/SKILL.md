---
name: vibe-fortress-review
description: |
  vibe-teamで実装リスクを動的Tier判定し、Codex+Claude混成チームで多角レビューを実行する。
  vibe-editor Canvas版。fortress-review の Agent Teams概念を vibe-team MCP に翻訳。
  トリガー: "vibe-fortress-review", "vibeでレビュー", "canvasレビュー"
  使用場面: (1) DB migration + 認証/課金が絡む重大変更、(2) アーキテクチャ変更、
  (3) 本番障害の修正で再発が許されない場合、(4) ここぞという実装
---

# vibe-fortress-review — vibe-team 動的多角レビュー

## 概要

fortress-review の vibe-team版。実装リスクを **15シグナルで自動Tier判定** し、
必要十分なレビューチームを `team_recruit` で動的に編成する。

**設計根拠**: プロンプト精度×適切なN で信頼性を最大化。エージェント数を固定で増やさない。

```
Step 0: 入力受付 → Step 1: Tier判定 → Step 2: Round 1並列レビュー
→ Step 3: Human Gate → Step 4: Round 2深掘り → Step 5: 最終判定
```

### 核心原則（三者一致点）

1. **プロンプトの質 > エージェント数** — チェックリスト形式でPASS/FAIL＋根拠を強制
2. **Human Gateは省略不可** — エージェント間統合の自動化を試みない
3. **Round 2は全員再起動ではない** — 問題箇所の深掘りのみ
4. **Codexの強みはコード操作** — 抽象的判断ではなくgrep/テスト生成/影響範囲列挙

### 依存スキル

| スキル | 参照タイミング | 用途 |
|--------|-------------|------|
| `vibe-shared-roles` | team_recruit 前 | ロール定義・instructions テンプレート取得 |
| `design-review-checklist` | reviewer_tech の instructions 埋め込み | Phase 1-9 統合 |
| `judgment-policy` | 全ワーカーの判断基準 | JP-01〜JP-12 自律判断 |

---

## トリガー条件 / 入力形式

```
/vibe-fortress-review [Issue URL | PR URL | 計画テキスト] [オプション]
```

| 入力形式 | 例 | 取得方法 |
|----------|-----|---------|
| Issue URL | `https://github.com/org/repo/issues/123` | `gh issue view 123 --json body,title,labels` |
| PR URL | `https://github.com/org/repo/pull/456` | `gh pr view 456 --json body,title,files,diff` |
| 計画テキスト | 直接テキスト or ファイルパス | Read ツール |
| 引数なし | 現在のブランチの最新変更 | diff フォールバック |

**引数なし時のdiffフォールバック:**
1. `git diff staging...HEAD` → staging なければ `git diff main...HEAD`
2. diff が空（0行）→ 「レビュー対象なし。`/sub-review` を推奨」で終了

---

## 差異マッピングテーブル

| Agent Teams 概念 | vibe-team MCP | 備考 |
|-----------------|---------------|------|
| `Agent(subagent_type: general-purpose)` | `team_recruit({role_id: "xxx", engine: "claude", instructions: "..."})` | ロール定義は vibe-shared-roles から Read |
| `Agent(Bash: codex exec)` | `team_recruit({role_id: "xxx", engine: "codex"})` | Codex系ロールは engine: codex で自動選択 |
| 並列起動（複数 Agent ツール） | `team_assign_task({assignee: "xxx", description: "..."})` × N | 採用後に一括タスク割当 |
| サブエージェント結果取得 | `team_read({unread_only: true})` | 全エージェントの結果を順次収集 |
| エージェント破棄 | `team_dismiss({agent_id: "xxx"})` | Step 5 完了後に全メンバー解散 |
| メッセージ送信 | `team_send({to: "xxx", message: "..."})` | エージェントへの追加指示・フィードバック |
| 1メッセージ並列起動 | team_assign_task を連続呼出 | vibe-team は内部で並列実行 |
| diff埋め込み方式 | instructions 内に diff 直接記載 | 32KiB超は .vibe-team/tmp/ にファイル書出 |
| TeamDelete | `team_dismiss({agent_id: "xxx"})` | 完了報告後に即解散 |

---

## チーム編成計画

### Tier別動的採用テーブル

| Tier | スコア | ロール構成 | 合計 |
|------|--------|-----------|------|
| **A: 要塞** | ≥ 12 | risk_scorer + codex_analyzer×2 + reviewer_tech + reviewer_scenario + reviewer_security | 6体 |
| **B: 重要** | 6–11 | risk_scorer + codex_analyzer + reviewer_tech + reviewer_scenario | 4体 |
| **C: 標準** | < 6 | risk_scorer + codex_analyzer + reviewer_tech | 3体 |

**Round 2（条件付き追加）:** cross_checker + reviewer_arch = +2体

※ 7±2ルール: Tier Aでも6体なので Leader 直轄でOK。Round 2追加しても最大8体。

### --no-codex 時の代替構成

| Tier | 通常 | --no-codex時 |
|------|------|-------------|
| A | codex_analyzer×2 含む 6体 | codex_analyzer を reviewer_arch で代替 → 6体 |
| B | codex_analyzer×1 含む 4体 | codex_analyzer を reviewer_arch で代替 → 4体 |
| C | codex_analyzer×1 含む 3体 | codex_analyzer を Claude探索許可型で代替 → 3体 |

---

## リーダーワークフロー

### Step 0: 入力受付・解析

1. 入力形式を判定（Issue URL / PR URL / テキスト / 引数なし）
2. `gh` コマンド or Read ツールでコンテンツ取得
3. `git diff --stat` で変更ファイルリスト取得
4. 関連する CLAUDE.md / プロジェクト規約を Read

### Step 1: Tier判定

```
team_recruit({role_id: "risk_scorer", engine: "codex"})
team_assign_task({assignee: "risk_scorer", description: "以下の変更内容を15シグナルでスコアリングせよ"})
team_read({unread_only: true}) → Tier判定結果（JSON）
```

**risk_scorer の入力:**
- diff / Issue body / PR body
- `references/tier-scoring.md` の15シグナルテーブル

**risk_scorer の出力:**
```json
{
  "signals": [
    { "name": "DB migration", "weight": 5, "hit": true, "evidence": "ALTER TABLE users..." }
  ],
  "total_score": 14,
  "tier": "A",
  "breakdown": { "data": 8, "auth_billing": 5, "arch": 0, "scope": 0, "ops": 1 }
}
```

**Tier判定後の提示フォーマット:**
```
【Tier判定結果】
対象: Issue #XXX — {タイトル}
スコア: {N}点（内訳: データ層{N} + 認証課金{N} + アーキ{N} + 影響範囲{N} + 運用{N}）
Tier: {A/B/C}
エージェント構成: {ロール一覧}
```

**分岐:**
- スコア0 → fortress-review不要。`/sub-review` を推奨して終了
- `--tier` 指定あり → 自動判定を上書き
- `--dry-run` → ここで終了

### Step 2: Round 1 — 並列独立レビュー

1. vibe-shared-roles から必要ロールの instructions を Read
2. Tier に応じてエージェントを一括採用:

```
# Tier A の場合
team_recruit({role_id: "codex_analyzer", engine: "codex", instructions: "影響範囲分析..."})  # CS1
team_recruit({role_id: "codex_analyzer", engine: "codex", instructions: "テスト網羅性..."})  # CS2
team_recruit({role_id: "reviewer_tech", engine: "claude", instructions: "要件整合 + design-review-checklist Phase 1-9..."})
team_recruit({role_id: "reviewer_scenario", engine: "claude", instructions: "障害シナリオ..."})
team_recruit({role_id: "reviewer_security", engine: "codex", instructions: "セキュリティ..."})
```

3. 各エージェントに team_assign_task で並列タスク割当
4. プロンプト組み立て手順（CRITICAL: 省略禁止 — `references/agent-prompts.md` 参照）:
   1. 共通ヘッダー全文をコピー
   2. 各テンプレートの `{共通ヘッダー}` を上記テキストで置換
   3. `{プロジェクトディレクトリ}` → `git rev-parse --show-toplevel` の結果
   4. `{diffベース}` → Step 0で決定したdiffベース（`staging...HEAD` / `main...HEAD` / 指定commit）
   5. `{Issue本文 or 仕様テキスト}` → Step 0で取得したIssue body
   6. `{diff結果}` → Step 0で取得したdiff（500行超はファイル単位分割、担当観点に関連するdiffのみ）
   7. `{diffStatの結果}` → `git diff --stat` の出力（全エージェント共通）
   8. `{Agent略称}` → Agent略称テーブルに従う（CS1, CS2, RT, RSC, RS, CC, RA）

**エージェント起動ルール:**
- 全エージェントへの team_assign_task を連続呼出（逐次起動禁止）
- diff は instructions 内に直接埋め込み（ファイル探索させない）
- codex_analyzer は `codex exec --cd` 方式で自身がdiff取得（Windows 8191文字制限回避）
- 各エージェントに「あなたは絶対に失敗を許されないプロジェクトの最終責任者です」と明記

### Step 3: Human Gate（省略不可）

1. `team_read()` で全エージェントの結果を収集
2. 指摘を自動集約:
   - 同一指摘の統合 → **クロスバリデーション済み** マーク
   - 深刻度でソート（CRITICAL → HIGH → MEDIUM → LOW → INFO）

3. トリアージテーブルを提示:

```markdown
## Fortress Review — Round 1 結果

### Tier: {A/B/C}（スコア: {N}点）
### エージェント: {起動エージェント一覧}

| # | ID | カテゴリ | ファイル | 深刻度 | 判定 | クロス検証 | 問題概要 |
|---|-----|---------|---------|--------|------|-----------|---------|
| 1 | VFR-CS1-01 | SECURITY | src/... | CRITICAL | FAIL | CS1+RS | ... |
| 2 | VFR-RT-01 | LOGIC | src/... | HIGH | FAIL | | ... |

### Round 2 推奨
- CRITICAL/HIGH: {N}件 → Round 2 深掘り推奨
- MEDIUM以下: {N}件 → 記録のみ

**判断をお願いします:**
1. Round 2 に進む（CRITICAL/HIGH指摘を深掘り）
2. 指摘を確認して実装に進む（リスク受容）
3. 計画を修正してから再レビュー
```

**全エージェントPASS時のショートカット:**
全エージェントが「全項目PASS」→ Step 5（最終判定: Go）に自動進行

**--auto-gate 時:**
- CRITICAL=0 → 自動 Go
- CRITICAL≥1 → 自動 No-Go

### Step 4: Round 2 — 絞り込み深掘り（条件付き）

Human Gate で「Round 2 に進む」が選択された場合のみ実行。

```
team_recruit(cross_checker, engine: codex)    # 修正案生成 + 副作用検証
team_recruit(reviewer_arch, engine: claude)    # 矛盾裁定 + 残存リスク評価
```

**Round 2 の入力:**
- Round 1 の全指摘（トリアージ済み）
- Human Gate での判断コメント
- 対象ファイルの現在の全文（diffだけでなく）

| エージェント | 起動条件 |
|-------------|---------|
| cross_checker | CRITICAL/HIGH指摘が1件以上 |
| reviewer_arch | 矛盾する指摘が存在する場合 |

### Step 5: 最終判定 → チーム解散

**Go / No-Go 基準:**

| 判定 | 条件 | 次のアクション |
|------|------|---------------|
| **Go** | CRITICAL=0, HIGH=0（全て解決済み） | 実装開始を許可 |
| **条件付きGo** | CRITICAL=0, HIGH≤2（対策明記済み） | 対策を実装計画に追記して進行 |
| **No-Go** | CRITICAL≥1 未解決 | 計画の根本修正が必要 |

**最終レポート:**

```markdown
## Fortress Review 最終レポート

### 基本情報
- 対象: {Issue/PR/計画の概要}
- Tier: {A/B/C}（スコア: {N}点）
- エージェント総数: R1: {N}体 + R2: {N}体

### 判定: {Go / 条件付きGo / No-Go}

### 指摘サマリ
| 深刻度 | 検出 | 解決済 | 未解決 |
|--------|------|--------|--------|
| CRITICAL | N | N | N |
| HIGH | N | N | N |
| MEDIUM | N | N | N |

### クロスバリデーション（複数エージェントが検出）
- {リスト}

### 残存リスク
- {修正後も残るリスクのリスト}
```

**チーム解散:**
```
team_dismiss({agent_id: "risk_scorer"})
team_dismiss({agent_id: "codex_analyzer_1"})
team_dismiss({agent_id: "codex_analyzer_2"})     # Tier A のみ
team_dismiss({agent_id: "reviewer_tech"})
team_dismiss({agent_id: "reviewer_scenario"})  # Tier B+ のみ
team_dismiss({agent_id: "reviewer_security"})  # Tier A のみ
team_dismiss({agent_id: "cross_checker"})      # Round 2 のみ
team_dismiss({agent_id: "reviewer_arch"})      # Round 2 のみ
```

---

## 共通出力フォーマット

全エージェント共通の指摘出力形式（省略禁止）:

```
【検出項目】
- ID: VFR-{Agent略称}-{連番}
- ファイル: {パス}:{行番号}
- カテゴリ: ARCHITECTURE | LOGIC | SECURITY | DATA_INTEGRITY | REQUIREMENT | OPERATIONAL
- 深刻度: CRITICAL | HIGH | MEDIUM | LOW | INFO
- 判定: PASS | FAIL | WARN
- 問題: {1-2文}
- 根拠: {コードから直接証明可能な事実}
- 修正案: {深刻度HIGH以上の場合のみ、具体的コード}
- 残存リスク: {修正後も残るリスクがあれば記載}

問題なしの場合: 「全項目PASS」と1行で報告。
```

**Agent略称:**

| ロール | 略称 | 例 |
|--------|------|-----|
| codex_analyzer (1体目) | CS1 | VFR-CS1-01 |
| codex_analyzer (2体目) | CS2 | VFR-CS2-01 |
| reviewer_tech | RT | VFR-RT-01 |
| reviewer_scenario | RSC | VFR-RSC-01 |
| reviewer_security | RS | VFR-RS-01 |
| cross_checker | CC | VFR-CC-01 |
| reviewer_arch | RA | VFR-RA-01 |

---

## オプション引数

| 引数 | 説明 | 例 |
|------|------|-----|
| `--tier A` | Tier を手動指定（自動判定を上書き） | `/vibe-fortress-review #123 --tier A` |
| `--no-codex` | Codexエージェントをスキップ（Claude代替） | `/vibe-fortress-review #123 --no-codex` |
| `--full` | Tier A相当（6体）に強制 | `/vibe-fortress-review #123 --full` |
| `--dry-run` | Tier判定のみ実行（エージェント起動なし） | `/vibe-fortress-review #123 --dry-run` |
| `--auto-gate` | Human GateでCRITICAL=0→自動Go（autopilot連携用） | `/vibe-fortress-review #123 --auto-gate` |

---

## 既存スキルとの連携

| 連携先 | タイミング | 連携方法 |
|--------|-----------|---------|
| `design-review-checklist` | Step 2（reviewer_tech の instructions） | Phase 1-9 を内部参照 |
| `vibe-shared-roles` | Step 2（team_recruit 前） | ロール instructions テンプレート取得 |
| `sub-review` | fortress-review **後** の実装diff確認 | 別途 `/sub-review` で起動 |
| `vibe-issue-planner` | fortress-review **前** の計画作成 | 計画コメントを入力として受け取る |
| `vibe-fortress-implement` | Go 判定後の実装フェーズ | Slice & Prove 方式で実装 |

---

## アンチパターン

| やってはいけないこと | なぜダメか | 正しいアプローチ |
|-------------------|----------|---------------|
| Human Gate をスキップ | エージェント間矛盾を自動解消しようとすると偽陽性の洪水 | 必ず人間が最終判断 |
| Round 2 で全員再起動 | コスト爆発＋前回と同じ結果を返すだけ | CRITICAL/HIGH指摘の深掘りのみ |
| diff を全エージェントに全文配布 | コンテキスト圧迫＋観点が散漫に | 担当観点に関連するdiffのみ配布 |
| risk_scorer を省略して手動Tier判定 | 判定基準の属人化 | 15シグナルの機械的スコアリングを徹底 |
| team_dismiss を忘れる | エージェントが残留してリソース消費 | Step 5 で全メンバー解散 |

---

## トラブルシューティング

| 問題 | 対処法 |
|------|--------|
| Codexタイムアウト | Claude エージェントの結果のみで判定継続。Tier C で唯一の codex_analyzer がタイムアウトした場合は Claude（探索許可）を1体追加採用 |
| 偽陽性が多い | `--tier C` で縮小実行、または instructions の判定基準を厳格化 |
| エージェント間で矛盾 | Human Gate で人間が裁定。Round 2 reviewer_arch に裁定を依頼 |
| 32KiB超の diff | `.vibe-team/tmp/<short_id>.md` にファイル書出し、instructions にサマリ+パスのみ記載 |
| 結果が長大 | team_read の結果をサマリ化してからトリアージテーブル生成 |
| team_recruit 失敗 | エラー内容確認 → role_id/engine の typo チェック → team_diagnostics で状態確認 |
| risk_scorer が不正確なTier返却 | `--tier` で手動上書き可能。tier-scoring.md のシグナル定義を確認 |

---

## 参照ファイル

| ファイル | 内容 |
|---------|------|
| `references/tier-scoring.md` | 15シグナルスコアリングテーブル詳細 |
| `references/agent-prompts.md` | 各エージェントへのプロンプトテンプレート |
| `../vibe-shared-roles/SKILL.md` | 共通ロール定義（instructions テンプレート） |
| `../design-review-checklist/SKILL.md`（存在する場合のみ参照） | Phase 1-9 チェックリスト |

---

## 外部スキル依存（オプショナル）

以下のスキルがインストール済みの場合は自動的に参照されます。未インストールでも動作します。
- judgment-policy: ユーザー判断基準（未設定時は都度ユーザーに確認）
- design-review-checklist: 設計レビューチェック（未設定時はスキップ）
- issue-naming: Issue命名規則（未設定時はデフォルト命名）

---

## 改訂履歴

| 日付 | 変更内容 | 変更理由 |
|------|---------|---------|
| 2026-05-02 | 初版作成 | fortress-review の vibe-team MCP 翻訳版として新規作成 |
