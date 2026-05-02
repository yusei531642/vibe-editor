---
name: vibe-fortress-implement
description: |
  vibe-teamでSlice & Prove方式の多重防御実装を実行する。vibe-editor Canvas版。
  トリガー: "vibe-fortress-implement", "vibeで要塞実装", "canvas要塞実装"
  使用場面: (1) DB migration + 認証が絡む重大実装、(2) 本番障害修正で再発不許可、
  (3) アーキテクチャ変更の段階的実装、(4) 1つのタスクを確実に完遂したい場合
---

# vibe-fortress-implement — vibe-team 多重防御実装スキル

> **Learning Style Override**: このスキル実行中は「Learn by Doing」を**無効**とする。Slice実装ループの中断は品質保証パイプラインを破壊するため、人間への実装委譲は行わない。
>
> **一気通貫原則**: ユーザー判断を仰ぐのは **severity=CRITICAL** または **Codex判断不能** の場合のみ。設計判断を含む選択肢分岐は **CODEX_CONSULT** で自動判定し、パイプラインを継続する。Claude が独断で「どれにしますか？」とユーザーに質問して停止することは**禁止**。

## 概要

fortress-implement を vibe-team MCP フローに翻訳したスキル。単一の実装タスクを **Slice（最小検証可能単位）に分解**し、各Sliceで「テスト先行 → 実装 → クロスチェック → Safe Point」のループを回す。失敗したら直近の Safe Point に戻って再設計する。

**速く作るスキルではなく、止まるべき時に止まり、戻るべき時に戻り、最後に証明して終えるスキル。**

```
Phase 0: 要件凍結 → Phase 1: 設計検証 & Slice計画
  → Phase 2: Slice実装ループ（コア） → Phase 3: 統合検証
  → Phase 4: 証跡パック & Go/No-Go
```

### 核心原則

1. **テスト先行は絶対** — bugは再現テスト、featは受入テストを先に書く
2. **1 Sliceは1つの関心事** — リファクタ・機能追加・依存更新を混ぜない
3. **クロスチェックは実装者以外** — 自己正当化を構造的に排除
4. **Safe Pointは省略不可** — 5点セット必須
5. **完了 = 証明** — 証跡パックが揃って初めて完了

---

## トリガー条件 / 入力形式

```
/vibe-fortress-implement [Issue URL | 計画テキスト] [オプション]
```

| 入力形式 | 例 | 取得方法 |
|----------|-----|---------|
| Issue URL | `https://github.com/org/repo/issues/123` | `gh issue view 123 --json body,title,labels,comments` |
| 計画テキスト | 直接テキスト or ファイルパス | Read ツール |
| PR修正依頼 | `https://github.com/org/repo/pull/456` | `gh pr view 456 --json body,title,files,comments` |
| 引数なし | 現在のブランチの最新Issue | `gh issue list --assignee @me -l planned` |

### オプション引数

| 引数 | 説明 |
|------|------|
| `--tier I2` | Tier を手動指定 |
| `--no-codex` | Codex系エージェントをClaude代替 |
| `--dry-run` | Tier判定 + Slice計画のみ |
| `--skip-e2e` | E2E検証をスキップ |
| `--max-slices N` | Slice数上限 |
| `--resume` | 状態ファイルから再開 |

---

## 差異マッピングテーブル — Agent Teams → vibe-team MCP

| fortress-implement (Agent Teams) | vibe-fortress-implement (vibe-team MCP) |
|---|---|
| `Agent(subagent_type=...)` | `team_recruit({ role_id, engine, label, description, instructions })` |
| Agent プロンプト埋め込み | `team_assign_task(assignee, description)` |
| Agent 結果取得 (return) | `team_read({ unread_only: true })` で `team_send` 報告を受信 |
| `codex exec --full-auto` | `team_recruit({ engine: "codex" })` + `team_assign_task` |
| Agent 自動終了 | `team_dismiss(member_id)` で明示的に解放 |
| 並列 Agent 起動 | 順次 `team_recruit` → 各自に `team_assign_task`（並列実行） |
| `tasks/fortress-implement-state.json` | `.vibe-team/tmp/fortress-implement-state.json` |
| `codex exec` (CODEX_CONSULT) | `team_recruit({ role_id: "codex_analyzer", engine: "codex" })` + task委任 |

---

## チーム編成計画 — Tier別動的構成

Leader が `team_recruit` で Tier に応じたメンバーを動的に採用する。

### ロール定義

| role_id | engine | label | 責務 |
|---------|--------|-------|------|
| `risk_scorer` | claude | リスク評価者 | Phase 1: Tier判定スコアリング |
| `slice_implementer` | claude | Slice実装者 | Step A-B: テスト先行 + 最小差分実装 |
| `reviewer_tech` | claude | 技術レビュアー | Step C: ロジック + 要件整合レビュー |
| `cross_checker` | codex | クロスチェッカー | Step C: 影響範囲 + セキュリティ分析 |
| `codex_analyzer` | codex | テスト強化分析 | Step C: 境界値テスト生成 + CODEX_CONSULT |
| `reviewer_devil` | claude | 障害シナリオ審査 | Step C: 本番障害シナリオ列挙 |
| `nver_implementer` | codex | N-ver独立実装者 | Step B: 独立実装 → diff比較 |
| `reviewer_security` | claude | セキュリティ専任 | Step C: 認証/課金/RLS専門レビュー |
| `state_keeper` | claude | 状態管理者 | 全Phase: state.json 管理 + Safe Point記録 |

### Tier別採用マトリクス

| role_id | I0 (0-7) | I1 (8-14) | I2 (15-21) | I3 (22+) |
|---------|----------|-----------|------------|----------|
| slice_implementer | o | o | o | o |
| reviewer_tech | o | o | o | o |
| cross_checker | - | o | o | o |
| codex_analyzer | - | o | o | o |
| reviewer_devil | - | - | o | o |
| nver_implementer | - | - | - | o |
| reviewer_security | - | - | - | o |
| **Slice単位の合計** | **2** | **4** | **5** | **7** |

> I3 は 7±2 ルールぎりぎり。Leader が直轄で全員を管理する。

### 採用コール例（I1の場合）

```
team_recruit({ role_id: "slice_implementer", engine: "claude",
  label: "Slice実装者", description: "テスト先行+最小差分実装",
  instructions: "references/agent-prompts.md の共通ヘッダー + IM セクション参照" })

team_recruit({ role_id: "reviewer_tech", engine: "claude",
  label: "技術レビュアー", description: "ロジック+要件整合レビュー",
  instructions: "..." })

team_recruit({ role_id: "cross_checker", engine: "codex",
  label: "クロスチェッカー", description: "影響範囲+セキュリティ分析",
  instructions: "..." })

team_recruit({ role_id: "codex_analyzer", engine: "codex",
  label: "テスト強化分析", description: "境界値テスト+CODEX_CONSULT",
  instructions: "..." })
```

---

## Phase 0: 要件凍結（Intake Freeze）

### 凍結チェックリスト

```
- [ ] 実装対象が1文で記述できる
- [ ] 受入条件が「○○のとき△△になる」形式で定義
- [ ] 非対象（やらないこと）が明示
- [ ] 前提条件（依存API、DB状態、環境）が列挙
- [ ] 成功の定義がテスト可能な形で記述
```

**ゲート条件**: 全項目チェック。曖昧な項目が残る場合はユーザーに確認して停止。

**出力: Mission Brief** — 対象(1文)、受入条件、非対象、前提条件、成功の定義を凍結文書化。

---

## Phase 1: 設計検証 & Slice計画

### 1.1 Tier判定

Leader が `risk_scorer` を `team_recruit` で採用し、スコアリングを委任する。

| カテゴリ | シグナル | 重み |
|---------|---------|------|
| 仕様不確実性 | 要件に複数解釈の余地 | 3 |
| 仕様不確実性 | 未定義のエッジケースが多い | 2 |
| 影響半径 | 変更予定ファイル6個以上 | 2 |
| 影響半径 | 複数モジュール横断（3層以上） | 3 |
| 不可逆性 | DB migration | 5 |
| 不可逆性 | 外部API契約変更 | 4 |
| データ/セキュリティ | 認証/認可ロジック変更 | 5 |
| データ/セキュリティ | 課金ロジック変更 | 5 |
| 外部依存 | 新規外部パッケージ導入 | 2 |
| 外部依存 | 外部API呼び出しの追加/変更 | 3 |
| テスト容易性 | 既存テストカバレッジが低い | 3 |
| テスト容易性 | E2Eテスト困難 | 2 |

**Tier閾値**:

| Tier | スコア | Slice粒度 | レビュー強度 |
|------|--------|----------|------------|
| I0 | 0-7 | 2-3 Slice | 1系統 |
| I1 | 8-14 | 3-5 Slice | 2系統 |
| I2 | 15-21 | 5-8 Slice | 2系統 + vibe-fortress-review |
| I3 | 22+ | 8+ Slice | 3系統 + vibe-fortress-review + N-ver |

**スコア0**: vibe-fortress-implement は過剰。通常の実装フローを推奨して終了。

`risk_scorer` 完了後 → `team_dismiss` で解放。

### 1.2 Slice分解

Sliceは「独立に検証・ロールバック可能な最小実装単位」。

**Slice分解の原則:**
1. 1 Sliceは1つの関心事のみ
2. migration、設定変更、権限変更は専用Sliceに隔離
3. 各Sliceに明確な受入テストを定義
4. Slice間の依存順序を明示

**出力（ユーザー承認必須）:**

```
【Slice計画】Tier: {I0-I3}（スコア: {N}点）

| # | Slice名 | 目的 | 受入テスト | 依存 | 推定規模 |
|---|---------|------|----------|------|---------|
| 1 | DB schema追加 | 新テーブル作成 | migration適用確認 | なし | S |
| 2 | API実装 | CRUDエンドポイント | 単体テスト全PASS | Slice 1 | M |
```

### 1.3 vibe-fortress-review連携（Tier I2+のみ — 自動実行）

Tier I2 以上では vibe-fortress-review の **Phase 1（設計検証）を自動実行**する。Leader が手動で判断するのではなく、パイプラインの一部として自動的に投入される。

- **CRITICAL=0** の場合のみ Phase 2（Slice実装ループ）に進行
- **CRITICAL>=1** → Slice計画修正が必要。ユーザー判断を仰ぐ

---

## Phase 2: Slice実装ループ（コアフェーズ）

### 2.1 ループ構造

各Sliceに対し5ステップを順次実行:

| Step | 内容 | Gate条件 |
|------|------|---------|
| **A: テスト先行** | `team_assign_task(slice_implementer)` でテスト作成 | テスト定義 + 期待FAIL確認 |
| **B: 最小差分実装** | 同上でテストGREEN化 | テストGREEN |
| **C: クロスチェック** | Tier別に reviewer 系ロールへ `team_assign_task` | CRITICAL/HIGH=0 |
| **D: 全検証** | lint → type → test + 想定外差分チェック | 全PASS + 想定外差分0 |
| **E: Safe Point** | git commit + 5点セット記録 | 記録完了 |

**Gate FAIL → Self-Healing Loop** （詳細: `references/self-healing-logic.md`）

**各ステップの詳細手順**: `references/slice-execution-loop.md` を Phase 2 開始時にRead

### 2.2 Step C: Tier別クロスチェック構成

**I0**: `reviewer_tech` のみ（ロジック+要件+影響範囲を統合）
**I1**: `reviewer_tech` + `cross_checker` + `codex_analyzer` を並列 `team_assign_task`
**I2**: 上記 + `reviewer_devil` を並列
**I3**: Step B で `slice_implementer` + `nver_implementer` が並列実装 → diff比較後、全 reviewer 並列

### 2.3 Safe Point（5点セット）

| # | 項目 | 内容 | 用途 |
|---|------|------|------|
| 1 | commit hash | git commit hash | ロールバック基点 |
| 2 | 合格テスト一覧 | PASS/FAILテスト名 | 回帰検知 |
| 3 | 変更ファイル一覧 | git diff --stat | 影響範囲確認 |
| 4 | ロールバック手順 | `git reset --soft {hash}` | 即時復元 |
| 5 | 前提メモ | このSliceが依存する前提 | 前提崩壊検知 |

### 2.4 CODEX_CONSULT（設計判断の自動委任）

Claude が迷う設計判断を `codex_analyzer` に委任し、パイプラインを止めずに継続する。

**手順:**
1. `team_assign_task(codex_analyzer, "{状況・選択肢A/B/C・判定基準}")` で委任
2. `team_read` で `選択: {X}\n理由: {1-2文}` 形式の応答を受信
3. 選択肢に対応する RecoveryAction に変換して自動継続
4. 状態ファイルの `self_healing_log` に記録
5. ユーザー通知は1行のみ: `[Slice S{N}] Codex判定により選択肢{X}を自動採用`

**フォールバック（非ブロッキング保証）:**

| 状況 | 挙動 |
|------|------|
| codex_analyzer タイムアウト | ESCALATE → ユーザー報告 |
| 「判断不能」応答 | ESCALATE → ユーザー報告 |
| 形式不整合 | 1回再試行 → 再失敗で ESCALATE |
| `--no-codex` 指定時 | CODEX_CONSULT 無効 → ESCALATE |

---

## Phase 3: 統合検証

全Slice完了後、以下を順次実行:

1. **lint** — 全PASS確認
2. **type-check** — 全PASS確認
3. **test** — 全テストPASS（Slice単位テスト含む）
4. **build** — ビルド成功確認
5. **回帰テスト** — 変更前PASSのテストが引き続きPASS

**Tier I2+**: E2Eテストを追加実施（e2e-test スキル連携）
**Tier I3**: N-version検証 — `nver_implementer` の独立実装と `slice_implementer` の実装を diff比較。不一致箇所は `reviewer_tech` が裁定。

---

## Phase 4: 証跡パック & Go/No-Go

### Go/No-Go基準

| 判定 | 条件 | 次のアクション |
|------|------|---------------|
| **Go** | 全Slice PASS + 統合テスト全PASS + E2E PASS(I2+) | 完了。PRマージ可 |
| **条件付きGo** | MEDIUM以下の未解決指摘あり | 技術負債Issueに記録して進行 |
| **No-Go** | CRITICAL/HIGH未解決 or テスト未PASS | 再設計が必要 |

### 証跡パック出力

```
## vibe-fortress-implement 証跡パック

### 基本情報
- 対象: {Mission Briefの1行要約}
- Tier: {I0-I3}（スコア: {N}点）
- Slice数: {N} / 完了: {N} / 失敗: {N}
- チーム構成: {採用したロール一覧}

### 判定: {Go / 条件付きGo / No-Go}

### Slice実行結果
| # | Slice名 | 試行回数 | 結果 | Safe Point |
|---|---------|---------|------|-----------|

### テスト結果サマリ
- lint: PASS / type-check: PASS / unit: N/N / integration: N/N / E2E: PASS|SKIP

### Self-Healing統計
- CODEX_CONSULT回数: {N} / ROLLBACK回数: {N}
```

### Phase 4 完了後のチーム解散

全メンバーを `team_dismiss` で解放する。state_keeper が最終状態を書き込んだ後に解放。

---

## 状態管理

`.vibe-team/tmp/fortress-implement-state.json` を **SSoT（Single Source of Truth）** とし、進捗・Safe Point・resume 判定はこのファイルを唯一の正として扱う。`state_keeper` がこのファイルを管理する。他の情報源（git log、PR コメント等）と食い違った場合は、state file を基準に照合・更新する。

```json
{
  "mission_brief": "{1行要約}",
  "tier": "I1",
  "tier_score": 10,
  "total_slices": 4,
  "current_slice": 2,
  "phase": "PHASE_2",
  "next_action": "STEP_B for S2",
  "team_members": ["slice_implementer", "reviewer_tech", "cross_checker", "codex_analyzer"],
  "slices": [
    {
      "id": "S1", "name": "DB schema追加", "status": "COMPLETED",
      "safe_point": { "commit_hash": "abc1234", "tests_passed": [], "files_changed": [], "rollback_cmd": "", "premises": "" },
      "attempts": 1, "review_summary": { "critical": 0, "high": 0, "medium": 1 }
    }
  ],
  "self_healing_log": [],
  "started_at": "2026-05-02T10:00:00Z",
  "fortress_review_result": null
}
```

### resume 再開手順

1. `.vibe-team/tmp/fortress-implement-state.json` を読み込み
2. `next_action` で再開ポイントを特定
3. **GitHub 実態照合**: state file の内容を以下の実態と突き合わせる
   - `gh issue view` / `gh pr view` で Issue/PR の状態・コメント・チェック結果を取得
   - `git log --oneline -10` / `git rev-parse HEAD` でブランチ HEAD を Safe Point の `commit_hash` と比較
   - 差分がある場合: state file を実態に合わせて更新。復旧不能な乖離（PR がクローズ済み、ブランチ消失等）があれば停止報告
4. `team_members` に基づき必要なメンバーを `team_recruit` で再採用
5. Safe Point の `commit_hash` で git 状態を検証

---

## Self-Healing ロジック（概要）

5層判定でGate FAIL時の回復戦略を決定する。

| Layer | 判定基準 | アクション |
|-------|---------|-----------|
| **0** | design_decision=true | → CODEX_CONSULT |
| **1** | severity=CRITICAL | → ROLLBACK（即時） |
| **2** | 同一error_pattern 2回再発 | → CODEX_CONSULT |
| **3** | error_type別分岐 | LINT/TYPE→RETRY_SAME, TEST→条件分岐, REVIEW+HIGH→CODEX_CONSULT |
| **4** | attempt >= 3 | → CODEX_CONSULT（最終裁定） |

**制約（ガードレール）:**
- 最大リトライ: Slice単位3回（4回目は CODEX_CONSULT 経由）
- CRITICAL: 即時 ROLLBACK（リトライなし）
- design_decision=true: 深刻度問わず CODEX_CONSULT
- CODEX_CONSULT タイムアウト時: ESCALATE にフォールバック

**詳細**: `references/self-healing-logic.md` 参照

---

## オンデマンドRead指示

| Phase | Read対象 | タイミング |
|-------|---------|-----------|
| Phase 1 (I2+) | vibe-fortress-review SKILL.md | fortress-review連携時 |
| Phase 2 開始 | references/slice-execution-loop.md | Slice実行ループ開始時（必須） |
| Phase 2 | references/agent-prompts.md | エージェント起動時 |
| Phase 2 | references/self-healing-logic.md | Gate FAIL発生時 |

---

## 既存スキルとの連携

```
issue-planner（計画作成）
     |
     v
vibe-fortress-implement（確実な実装実行）  <-- THIS
     |-- vibe-fortress-review（Phase 1 設計検証、Tier I2+）
     |-- codex_analyzer（クロスチェック + CODEX_CONSULT）
     +-- e2e-test（Phase 3 E2E検証）
     |
     v
sub-review（最終diffレビュー）
```

---

## トラブルシューティング

| 問題 | 対処法 |
|------|--------|
| Codex engine タイムアウト | cross_checker/codex_analyzer を engine: "claude" で再採用 |
| Slice粒度が大きすぎる | Sliceをさらに分割。1 Slice = 1ファイル変更を目安に |
| Self-Healing 3回失敗 | CODEX_CONSULT → Codex不能時のみ ESCALATE |
| 設計判断でLeaderが迷う | ユーザーに質問せず CODEX_CONSULT 発動 |
| team_recruit 上限到達 | 不要メンバーを team_dismiss で解放してから再採用 |
| 状態ファイル破損 | git logからSafe Point復元。`--resume` で再開 |
| `--no-codex` 指定時 | codex engine のロールを全て claude で代替採用 |

---

## 外部スキル依存（オプショナル）

以下のスキルがインストール済みの場合は自動的に参照されます。未インストールでも動作します。
- judgment-policy: ユーザー判断基準（未設定時は都度ユーザーに確認）
- design-review-checklist: 設計レビューチェック（未設定時はスキップ）
- issue-naming: Issue命名規則（未設定時はデフォルト命名）

---

## 改訂履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-05-02 | 初版作成 — fortress-implement を vibe-team MCP フローに翻訳 |
| 2026-05-02 | SSoT明記、resume時GitHub照合追加、I2+ review自動実行明記 | Task #8 レビュー指摘対応 |
