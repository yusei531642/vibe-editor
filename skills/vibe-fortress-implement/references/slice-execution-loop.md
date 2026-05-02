# vibe-fortress-implement — Slice実行ループ詳細手順

> Phase 2 開始時に必ずReadすること。

## Step A: テスト先行

### bugfixの場合

1. `team_assign_task(slice_implementer, "バグ再現テストを作成してください。...")` で委任
2. 再現条件を特定（Issue本文 or 報告内容から）
3. 再現テスト作成 → **RED（失敗）を確認**
4. `team_read` で結果を受信

### featureの場合

1. `team_assign_task(slice_implementer, "受入テストを作成してください。...")` で委任
2. Sliceの受入条件をテストに変換
3. 受入テスト作成 → **期待FAIL（未実装）を確認**

### テスト先行が困難な場合

| 状況 | 代替手段 |
|------|---------|
| UI操作系 | 受入条件を自然言語で記述。Phase 3のE2Eで検証 |
| 外部API依存 | モック付き統合テスト or コードパス整合性検証 |
| 環境依存 | 設定ファイルの差分検証 + ドライラン |

> 「テストが書けない」はSlice分解の失敗を示唆する。Slice再分解を検討すること。

---

## Step B: 最小差分実装

### team_assign_task コール例

```
team_assign_task(slice_implementer, """
## 実装指示: Slice {N} — {Slice名}

### Mission Brief
{Mission Brief全文}

### 受入テスト（このテストをGREENにすること）
{テストコード or テスト条件}

### 前Sliceまでの状態
{Safe Pointの前提メモ}

### 実装ルール
1. テストがGREENになる**最小限**のコードを書く
2. 関係ないリファクタリング・「ついでに」の改善は禁止
3. 別Sliceの先取り実装は禁止
4. 変更ファイルはSlice計画の予定ファイルのみ
5. 実装完了後:
   - git diff --stat で変更ファイル一覧を報告
   - lint + type-check + test を実行し結果を報告

team_send('leader', '完了報告: ...') で結果を返すこと。
""")
```

### 想定外差分の扱い

Slice計画の予定ファイル以外に変更がある場合:
- **自動生成ファイル**（型定義、ロックファイル等）: 許容。記録に残す
- **意図的な追加変更**: Slice計画を更新し、理由を記録
- **意図しない変更**: 即時revert。原因を調査

---

## Step C: クロスチェック

### Tier別 team_assign_task パターン

#### Tier I0（2エージェント）

```
# reviewer_tech にのみ委任（ロジック+要件+影響範囲を統合）
team_assign_task(reviewer_tech, """
## レビュー指示: Slice {N}
{Slice仕様 + 実装差分 + 変更ファイル一覧}
レビュー観点: 要件一致 / ロジック正当性 / 最小差分 / データフロー / 影響範囲
ID: FI-R1-S{N}-{連番}
team_send('leader', '完了報告: ...') で結果を返すこと。
""")
```

#### Tier I1（4エージェント）

```
# 3エージェントに並列で team_assign_task
team_assign_task(reviewer_tech, "...{ロジック+要件レビュー}...")
team_assign_task(cross_checker, "...{影響範囲+セキュリティ分析}...")
team_assign_task(codex_analyzer, "...{テスト強化+境界値テスト生成}...")

# team_read で全結果を収集
# CRITICAL/HIGH指摘があれば修正後に該当エージェントのみ再レビュー
```

#### Tier I2（5エージェント）

```
# I1 + reviewer_devil を追加
team_assign_task(reviewer_tech, "...{ロジック+要件}...")
team_assign_task(cross_checker, "...{影響範囲+セキュリティ}...")
team_assign_task(codex_analyzer, "...{テスト強化}...")
team_assign_task(reviewer_devil, "...{障害シナリオ+ロールバック可能性}...")
```

#### Tier I3（7エージェント）

```
# Step B で slice_implementer + nver_implementer が並列実装
team_assign_task(slice_implementer, "...{通常の実装指示}...")
team_assign_task(nver_implementer, "...{独立実装指示（他の実装を見ない）}...")

# 2実装のdiffを比較した後、全 reviewer に並列投入
team_assign_task(reviewer_tech, "...{ロジック+要件 + diff比較結果}...")
team_assign_task(cross_checker, "...{影響範囲+セキュリティ}...")
team_assign_task(codex_analyzer, "...{テスト強化}...")
team_assign_task(reviewer_devil, "...{障害シナリオ}...")
team_assign_task(reviewer_security, "...{認証/課金/RLS専門}...")
```

### クロスチェック結果の統合手順

1. `team_read({ unread_only: true })` で全エージェントの報告を収集
2. 同一指摘の統合（複数エージェントが検出 → **クロスバリデーション済み**マーク）
3. 深刻度でソート（CRITICAL → HIGH → MEDIUM → LOW）
4. 統合結果を表示:

```
## Slice {N} クロスチェック結果

| # | ID | カテゴリ | ファイル | 深刻度 | クロス検証 | 問題概要 |
|---|-----|---------|---------|--------|-----------|---------|

CRITICAL: {N}件 / HIGH: {N}件 / MEDIUM: {N}件
→ {CRITICAL+HIGH=0: Step Dへ | CRITICAL+HIGH>0: 修正後再レビュー}
```

---

## Step D: 全検証

以下を順次実行:

```bash
# 1. Lint
npm run lint
# → 0 error 必須

# 2. 型チェック
npm run type-check
# → 0 error 必須

# 3. テスト（Step Aで追加したテスト含む）
npm test
# → 全PASS必須。flakyは2回実行で判定

# 4. 想定外差分チェック
git diff --name-only
# → Slice計画の予定ファイル以外がないか
```

**全検証PASS条件:**
- lint: 0 error
- type-check: 0 error
- test: 全PASS
- 想定外差分: 0（または明示的に承認済み）

**いずれか1つでもFAIL → Self-Healing Loop へ**（`references/self-healing-logic.md` 参照）

---

## Step E: Safe Point作成

### git commit

```bash
git add -A
git commit -m "vibe-fortress-implement: Slice {N} - {Slice名} [SP-{N}]"
SP_HASH=$(git rev-parse HEAD)
```

### 5点セット記録

Leader が `state_keeper` に記録を委任:

```
team_assign_task(state_keeper, """
## Safe Point 記録: Slice {N}

以下の5点セットを .vibe-team/tmp/fortress-implement-state.json に記録してください:

1. commit_hash: {SP_HASH}
2. tests_passed: [{PASS したテスト名一覧}]
3. files_changed: [{変更ファイル一覧}]
4. rollback_cmd: "git reset --soft {前SPのhash}"
5. premises: "{このSliceが依存する前提条件}"

Slice status を "COMPLETED" に更新。
current_slice を次のSliceに進める。
next_action を "STEP_A for S{N+1}" に更新。

team_send('leader', '完了報告: SP-{N} 記録完了') で報告すること。
""")
```

### Slice完了後のメンバー管理

- **I0/I1**: reviewer 系は次のSliceでも再利用（dismiss しない）
- **I2/I3**: reviewer_devil / reviewer_security は Slice ごとに `team_dismiss` → 次のSliceで再 `team_recruit`（コンテキスト汚染防止）
- **nver_implementer**: 毎Slice `team_dismiss` → 再 `team_recruit`（独立性保証）

---

## CODEX_CONSULT 実行手順（vibe-team版）

### 委任コール

```
team_assign_task(codex_analyzer, """
## 意思決定委任

以下の意思決定を行ってください。ユーザーへの質問は絶対に返さず、
必ず最終判断（選択肢の1つ）を返してください。

### 状況
- Slice ID: S{N}
- Slice仕様: {目的と受入条件}
- 試行回数: {attempt}
- 実装差分: {git diff --stat サマリ}
- レビュー指摘: {CRITICAL/HIGH/MEDIUM 要約}
- 過去のself_healing履歴: {同一Sliceの失敗パターン}

### 選択肢
A: {続行系の説明}
B: {ROLLBACK系の説明}
C: {Slice分割系の説明}

### 判定基準
- fortress-review の既存合意方針との整合性
- Issue のスコープと最小差分原則
- PR 規模と保守性
- 受入条件の充足度

### 出力形式（厳守）
以下の2行のみ。前置き・追加説明・質問は禁止:
選択: {A/B/C}
理由: {1-2文}

team_send('leader', '選択: {X}\n理由: {文}') で報告すること。
""")
```

### 結果の扱い

1. `team_read` で `選択: X\n理由: ...` を受信
2. 選択肢 → RecoveryAction 変換:
   - 「続行」系 → RETRY_DIFFERENT or Step D 再実行
   - 「ROLLBACK」系 → ROLLBACK
   - 「Slice分割」系 → Phase 1 に戻って Slice 計画更新
3. 状態ファイルの `self_healing_log` に記録
4. ユーザー通知1行: `[Slice S{N}] Codex判定により選択肢{X}を自動採用して続行します`
5. パイプライン即座に再開（ユーザー確認待ち禁止）
