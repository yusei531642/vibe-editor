# vibe-fortress-implement — Self-Healing ロジック詳細

> Gate FAIL 発生時にReadすること。

## 5層判定ロジック

```
Gate FAIL検知
  |
  v
エラー分類（LINT / TYPE / TEST / REVIEW / UNEXPECTED）
  |
  v
isDesignDecision() でレビュー指摘文を走査
  |
  v
decideRecoveryAction() で5層判定
  |
  +-- RETRY_SAME -------> 同じアプローチで修正 → Step D再実行
  |
  +-- RETRY_DIFFERENT --> 別アプローチ指示 → Step B再実行
  |
  +-- ROLLBACK ---------> git reset --soft {前SP hash} → Slice再設計
  |
  +-- CODEX_CONSULT ----> codex_analyzer に選択肢委任 → 自動継続
  |                       失敗時 → ESCALATE フォールバック
  |
  +-- ESCALATE ---------> ユーザーに問題報告して停止
```

---

## Layer 0: 設計判断検出 → CODEX_CONSULT

**条件**: `isDesignDecision(failure) === true`
**アクション**: CODEX_CONSULT — `team_assign_task(codex_analyzer, ...)` で判断委任

### isDesignDecision() の判定ロジック

レビュー指摘文に以下のキーワードが含まれる場合、`design_decision=true`:

```
"表示契約", "APIスキーマ拡張", "スコープ拡張",
"PR規模膨張", "承認範囲を超える", "既知の残存リスク",
"設計判断", "アーキテクチャ判断", "トレードオフ",
"より洗練された", "代替設計", "実装方針の選択"
```

**設計思想**: 設計判断は Claude が独断でユーザーに投げず、codex_analyzer に委任して自動継続する。

---

## Layer 1: 即時判定（severity + attempt上限）

### CRITICAL → 即時 ROLLBACK

**条件**: `failure.severity === "CRITICAL"`
**アクション**: ROLLBACK — `git reset --soft {前SP hash}` を実行し、Slice再設計

- リトライなし
- CODEX_CONSULT にも委任しない
- ユーザーに報告して停止（ESCALATE）

### attempt >= 3 → CODEX_CONSULT

**条件**: `failure.attempt >= 3`
**アクション**: CODEX_CONSULT — ESCALATE直前に codex_analyzer に最終判定を仰ぐ

---

## Layer 2: パターン再発検知

同一 `error_pattern` の出現回数で分岐:

| 再発回数 | アクション | 理由 |
|---------|-----------|------|
| 1回目 | RETRY_DIFFERENT | 同じ修正を繰り返しても同じ結果。別アプローチへ |
| 2回以上 | CODEX_CONSULT | 3回目は codex_analyzer に別アプローチを設計させる |

**vibe-team での実装:**

```
# パターン再発検知
team_assign_task(state_keeper, """
.vibe-team/tmp/fortress-implement-state.json の self_healing_log から
Slice {N} の同一 error_pattern の出現回数を集計して報告してください。
team_send('leader', '再発回数: {N}') で報告すること。
""")
```

---

## Layer 3: error_type別対応テーブル

| error_type | attempt=1 | attempt=2 | 設計思想 |
|-----------|-----------|-----------|---------|
| **LINT** | RETRY_SAME | RETRY_SAME | 機械的修正可能。同アプローチでOK |
| **TYPE** | RETRY_SAME | RETRY_SAME | 型エラーは機械的修正可能 |
| **TEST** | RETRY_SAME | RETRY_DIFFERENT | 1回目は単純修正、2回目は別アプローチ |
| **REVIEW** (HIGH) | CODEX_CONSULT | CODEX_CONSULT | HIGH指摘はCodexに委任して自動継続 |
| **REVIEW** (MEDIUM以下) | RETRY_DIFFERENT | RETRY_DIFFERENT | 実装修正で対応可能 |
| **UNEXPECTED** | ROLLBACK | ROLLBACK | 安全側に倒す。想定外は即ロールバック |
| (default) | CODEX_CONSULT | CODEX_CONSULT | 不明なエラーはCodexに判断委任 |

---

## Layer 4: attempt上限（最終防御）

| attempt | アクション |
|---------|-----------|
| 1-2 | Layer 0-3 で判定 |
| 3 | CODEX_CONSULT（最終裁定） |
| 4+ | CODEX_CONSULT → Codex不能時のみ ESCALATE |

---

## CODEX_CONSULT の vibe-team 実行手順

### 1. 委任

```
team_assign_task(codex_analyzer, """
## 意思決定委任: Slice S{N}

### 状況
- Slice仕様: {目的と受入条件}
- 試行回数: {attempt}
- 実装差分 (git diff --stat): {差分サマリ}
- レビュー指摘: {CRITICAL/HIGH/MEDIUM 要約}
- 過去のself_healing履歴: {同一Sliceの失敗パターン}

### 選択肢
A: {例: 現状の実装のまま続行し、指摘を技術負債Issueに記録}
B: {例: ROLLBACK して別アプローチで再実装}
C: {例: Slice を分割して範囲を狭める}

### 判定基準
- fortress-review の既存合意方針との整合性
- Issue のスコープと最小差分原則
- PR 規模と保守性
- 受入条件の充足度

### 出力形式（厳守）
以下の2行のみ。前置き・追加説明・質問は禁止:
選択: {A/B/C}
理由: {1-2文}

team_send('leader', '選択: ...\n理由: ...') で報告。
""")
```

### 2. 結果受信

```
# team_read で報告を受信
# 形式: "選択: A\n理由: 現状の最小差分で受入条件を満たすため..."
```

### 3. RecoveryAction 変換

| 選択内容 | RecoveryAction |
|---------|---------------|
| 「続行」「現状のまま」系 | RETRY_DIFFERENT or Step D 再実行 |
| 「ROLLBACK」系 | ROLLBACK |
| 「Slice分割」系 | Phase 1 に戻って Slice 計画更新 |

### 4. 状態ファイル記録

```json
{
  "slice_id": "S{N}",
  "attempt": 3,
  "previous_error": {
    "type": "REVIEW",
    "pattern": "API スキーマ拡張によるスコープ超過",
    "severity": "HIGH",
    "design_decision": true
  },
  "recovery_action": "CODEX_CONSULT",
  "codex_decision": {
    "choice": "A",
    "reason": "現状の最小差分で受入条件を満たすため、追加提案は技術負債Issueに分離。",
    "resolved_action": "RETRY_DIFFERENT",
    "consulted_at": "2026-05-02T12:34:56Z",
    "fallback_used": false
  }
}
```

### 5. ユーザー通知（1行のみ）

```
[Slice S{N}] Codex判定により選択肢{X}を自動採用して続行します（理由: {Codexの理由}）。
```

### 6. パイプライン再開（ユーザー確認待ち禁止）

---

## フォールバック条件（CODEX_CONSULT → ESCALATE）

| 状況 | 記録 |
|------|------|
| codex_analyzer タイムアウト | `fallback_used: true`, `fallback_reason: "timeout"` |
| 「判断不能」「情報不足」応答 | `fallback_used: true`, `fallback_reason: "undecidable"` |
| 形式不整合が2回連続 | `fallback_used: true`, `fallback_reason: "format_error"` |
| `--no-codex` 指定時 | `fallback_used: true`, `fallback_reason: "no_codex_flag"` |

**ESCALATE されるケース（ユーザーに停止報告）:**
- severity=CRITICAL の ROLLBACK
- CODEX_CONSULT の全フォールバック条件に該当
- ユーザーが明示的に中断を要求

上記以外は必ず自動継続する。

---

## 制約（ガードレール）まとめ

| ルール | 内容 |
|--------|------|
| 最大リトライ | Slice単位3回。4回目は CODEX_CONSULT 経由 |
| 同一error_pattern 2回 | RETRY_DIFFERENT を強制 |
| 同一error_pattern 3回 | CODEX_CONSULT を強制 |
| CRITICAL severity | 即時 ROLLBACK（リトライ・Codex委任なし） |
| design_decision=true | 深刻度問わず CODEX_CONSULT |
| CODEX_CONSULT 不能時 | ESCALATE にフォールバック |
| ユーザーへの質問 | CRITICAL or Codex不能時のみ許可 |

---

## リトライ記録フォーマット

### 通常リトライ

```json
{
  "slice_id": "S{N}",
  "attempt": 2,
  "previous_error": {
    "type": "TEST",
    "pattern": "Property 'foo' does not exist on type 'Bar'",
    "severity": "HIGH",
    "design_decision": false
  },
  "recovery_action": "RETRY_SAME",
  "fix_description": "型定義にfooプロパティを追加"
}
```

### CODEX_CONSULT リトライ

```json
{
  "slice_id": "S{N}",
  "attempt": 3,
  "previous_error": {
    "type": "REVIEW",
    "pattern": "API スキーマ拡張",
    "severity": "HIGH",
    "design_decision": true
  },
  "recovery_action": "CODEX_CONSULT",
  "codex_decision": {
    "choice": "A",
    "reason": "...",
    "resolved_action": "RETRY_DIFFERENT",
    "consulted_at": "...",
    "fallback_used": false
  }
}
```

### ESCALATE 記録

```json
{
  "slice_id": "S{N}",
  "attempt": 4,
  "previous_error": { "type": "REVIEW", "severity": "HIGH", "design_decision": true },
  "recovery_action": "CODEX_CONSULT",
  "codex_decision": {
    "choice": null,
    "reason": null,
    "resolved_action": "ESCALATE",
    "consulted_at": "...",
    "fallback_used": true,
    "fallback_reason": "timeout"
  }
}
```
