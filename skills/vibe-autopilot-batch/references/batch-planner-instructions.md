# Batch Planning Agent（計画策定ワーカー）— vibe-team版

## batch-plan.json スキーマ

`codex_scout` がBatch Planning Agentとして `.vibe-team/tmp/batch-plan.json` に書き出す計画データ（不変）。
リーダーは Read で読み取るのみ。

```json
{
  "batch_id": "vibe-batch-20260502-1430",
  "repo": "owner/repo",
  "project_dir": "C:/Users/zooyo/Documents/GitHub/...",
  "input_mode": "all-planned",
  "execution_order": [11, 14, 13, 15],
  "issues": [
    {
      "number": 11, "title": "Auth API", "branch_hint": "feat/issue-11-auth-api",
      "priority": "P1", "effort": "M",
      "tier": "B",
      "tier_score": 8,
      "tier_breakdown": "data=3,auth=0,arch=4,scope=2,ops=0",
      "affected_files": ["src/auth.ts", "src/api/login.ts", "src/lib/session.ts"],
      "dependencies": [], "conflict_notes": "src/auth.ts は #14 と共有",
      "e2e_test_hints": ["ログイン画面表示確認", "認証APIレスポンス検証"],
      "has_plan_comment": true
    }
  ],
  "skipped": [{ "number": 12, "title": "UI改善", "reason": "implementing ラベル" }],
  "existing_merged_prs": [
    { "number": 273, "mergedAt": "2026-04-28T11:42:00Z", "headRefName": "fix/issue-258", "issue_number": 258 }
  ],
  "conflict_pairs": [{ "issues": [11, 14], "shared_files": ["src/auth.ts"], "recommended_order": "..." }],
  "codex_preflight_used": true, "codex_fallback": false,
  "total_target_count": 4, "total_skipped_count": 1
}
```

**`batch-plan.json` と `batch-pipeline-state.json` の関係:**
- `batch-plan.json`: 計画データ（不変）— codex_scout が書出し、リーダーが読取のみ
- `batch-pipeline-state.json`: 実行状態（可変）— Step 6で plan -> state にコピー、実行中に随時更新
- **resumeモードでは `batch-pipeline-state.json` のみ使用**

---

## リーダーが codex_scout を起動する手順

### Step 2: Batch Planning Agent 起動

```
# 1. vibe-shared-roles から codex_scout の instructions を Read
Read("../vibe-shared-roles/references/role-instructions/codex_scout.md")

# 2. codex_scout を採用
team_recruit({
  role_id: "codex_scout",
  engine: "codex",
  label: "Batch Planner",
  description: "Issue分析・計画策定",
  instructions: "{codex_scout基本instructions}\n\n{下記プロンプトテンプレート}"
})

# 3. タスク割当
team_assign_task("codex_scout_0", "Batch Planning を実行し batch-plan.json を書き出せ")
```

---

## Batch Planning Agent プロンプトテンプレート

以下を `team_recruit` の instructions に埋め込む:

```
あなたは vibe-autopilot-batch の Batch Planning Agent です。
リーダーに代わってIssue分析・計画策定を実行し、結果を .vibe-team/tmp/batch-plan.json に書き出してください。

## 入力情報
- リポジトリ: {repo}
- プロジェクトディレクトリ: {project_dir}
- 入力形式: {input_mode}（all-planned / Issue番号リスト / milestone:{name}）
- 指定Issue番号（リストモード時のみ）: {issue_numbers}

## Phase 0: ラベル準備
以下のラベルが存在しない場合のみ作成:
gh label create "implementing" --repo {repo} --color "FBCA04" --description "バッチ実装中" 2>/dev/null
gh label create "implemented" --repo {repo} --color "0075CA" --description "実装完了・E2E通過" 2>/dev/null
gh label create "regression" --repo {repo} --color "B60205" --description "リグレッション検出" 2>/dev/null
gh label create "found-during-e2e" --repo {repo} --color "E4E669" --description "E2E中発見の既存バグ" 2>/dev/null

## Phase 1: 対象Issue一覧取得
gh issue list --repo {repo} --state open --label "planned" --limit 100 \
  --json number,title,labels \
  -q '.[] | "\(.number)\t\(.title)\t\([.labels[].name] | join(","))"'

## Phase 2: スキップ判定
各Issueについて:
- implementing/implemented/implementation-failed ラベル -> スキップ
- assignee設定済み -> スキップ
- **既存PR（open / merged 両方）の検索**:
  gh pr list --repo {repo} --state all \
    --search "Issue #{number} OR issue-{number}" \
    --json number,state,headRefName,mergedAt,title
  - state=OPEN -> スキップ理由 "open-PR-exists-PR-{N}"
  - state=MERGED かつ過去24時間以内 -> スキップ理由 "already-merged-by-PR-{N}"、existing_merged_prs[] に追記
  - state=CLOSED（merged以外）-> 通常通り実装対象
- 実装計画コメントなし（「## 実装計画」がない）-> スキップ
**重要**: `--state open` のみだと merged 済み Issue を見逃す。必ず `--state all`。

## Phase 3: 実装計画コメント解析
対象Issueごとに gh issue view --comments で実装計画コメントを取得し、以下を抽出:
- priority: P0-P3（デフォルト P2）
- effort: S/M/L/XL（デフォルト M）
- affected_files: 影響ファイル一覧
- dependencies: 前提Issue番号リスト
- e2e_test_hints: テスト確認ポイント
- branch_hint: ブランチ名候補（feat/issue-{number}-{slug}）

### Tier情報パース（issue-planner-meta からの抽出）
計画コメント本文から `<!-- issue-planner-meta` ブロックを検索:
- `tier: {A|B|C}` -> issues[].tier
- `tier_score: {N}` -> issues[].tier_score
- `tier_breakdown: data={N},auth={N},...` -> issues[].tier_breakdown
パース失敗時: tier=null, tier_score=null（リーダー側でデフォルトTier B扱い）

### fortress ラベル自動判定
- tier == "A" -> `fortress-review-required` ラベルを付与
- tier_score と tier_breakdown から実装複雑度I2+を判定 -> `fortress-implement-required` ラベルを付与

## Phase 4: 実行順序決定
Codex pre-flight で最適化（失敗時はヒューリスティック順序でフォールバック）:
ソートルール:
1. 依存関係（DAGトポロジカルソート、ファイル競合も依存として扱う）
2. 優先度（P0 > P1 > P2 > P3）
3. 工数（S < M < L < XL）
4. Issue番号（タイブレーカー）

## Phase 5: batch-plan.json 書き出し
上記の分析結果を .vibe-team/tmp/batch-plan.json に書き出す。
batch_id は "vibe-batch-{YYYYMMDD}-{HHMM}" 形式。
バッチサイズ上限5件を超える場合はエラー報告。

## Phase 6: リーダーへ完了報告
team_send('leader', "完了報告: batch-plan.json 作成完了。対象{N}件、スキップ{N}件、競合ペア{N}件") で報告。
```

---

## 対象Issue取得とスキップ判定の詳細

**スキップ判定テーブル:**

| 条件 | 判定方法 | スキップ理由 |
|------|---------|------------|
| `implementing` ラベル | 別セッションが処理中 | implementing |
| `implemented` ラベル | 実装完了済み | implemented |
| `implementation-failed` ラベル | 前回バッチで失敗 | failed |
| assignee設定済み | 手動作業中 | assigned |
| オープンPR存在 | `gh pr list --state all` | open-PR-exists |
| merged済みPR（24h以内） | 同上 | already-merged |
| 実装計画コメントなし | `gh issue view` | no-plan-comment |

---

## リーダーの後続処理（Step 3-6）

### Step 3: batch-plan.json 読取 + バリデーション

`team_read` で codex_scout の完了報告を受信後:
1. `.vibe-team/tmp/batch-plan.json` を Read
2. 必須フィールド検証: execution_order, issues[], total_target_count
3. 各Issueに `has_plan_comment: true` があること
4. `codex_scout` を `team_dismiss` で解放

### Step 5: ユーザーに実行計画を提示

```
【vibe-autopilot-batch 実行計画】
バッチID: {batch_id}
対象: {total_target_count}件 | スキップ: {total_skipped_count}件

| # | Issue | タイトル | 優先度 | 工数 | Tier | 競合 |
|---|-------|---------|--------|------|------|------|
| 1 | #11   | Auth API | P1    | M    | B    | #14  |

推定所要時間: Issue数 × 13分 + feat件数 × 5分 + 統合回帰テスト15分
```

### Step 6: state_keeper 採用 + 状態ファイル初期化

```
# 1. vibe-shared-roles から state_keeper の instructions を Read
Read("../vibe-shared-roles/references/role-instructions/state_keeper.md")

# 2. state_keeper を採用
team_recruit({
  role_id: "state_keeper",
  engine: "codex",
  label: "状態管理者",
  description: "batch-pipeline-state.json 管理",
  instructions: "{state_keeper基本instructions}"
})

# 3. batch-plan.json から batch-pipeline-state.json を初期化
team_assign_task("state_keeper_0", "batch-plan.json を読み取り、
  .vibe-team/tmp/batch-pipeline-state.json を初期化せよ。
  各issueの phase='pending', processed_events=[] で初期化。
  context.next_action='#{first_issue} Phase A ワーカー起動'")
```
