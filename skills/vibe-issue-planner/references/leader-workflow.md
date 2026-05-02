# Leader ワークフロー詳細（9ステップ）

vibe-issue-planner の Leader が実行する9ステップの詳細手順。
各ステップで使用する vibe-team MCP コール例を含む。

---

## Step 1: 入力解析

ユーザー入力から `owner/repo` を抽出する。

```
入力例:
  /vibe-issue-planner https://github.com/Robbits-CO-LTD/digital-management-consulting-app/issues
  /vibe-issue-planner Robbits-CO-LTD/digital-management-consulting-app
  /vibe-issue-planner owner/repo --external-llm on

抽出:
  owner = "Robbits-CO-LTD"
  repo = "digital-management-consulting-app"
  external_llm_mode = "auto" | "on" | "off"
```

プロジェクトディレクトリの推定:
- MEMORY.md の「プロジェクトパス」セクションから対応ローカルディレクトリを特定
- 見つからない場合は `ls` で存在確認 → 最終手段としてユーザーに確認

---

## Step 1.5: ゲートキーパー（早期終了判定）

Issue Scanner Agent を起動する**前**に、軽量チェックで空振りを防止する。

```bash
gh issue list --repo owner/repo --state open --json number,labels --limit 200
```

判定ロジック:
1. オープンIssue 0件 → **即終了**（「オープンIssueがありません」と報告）
2. 全件が `planned` ラベル付き → **即終了**（「全Issue計画済みです」と報告）
3. 部分的に `planned` → 未計画件数を表示して**続行**
4. 対象1件以上 → **確認なしで Step 2 へ自動遷移**（核心ルール18）

進行宣言例: 「未計画Issue {N}件を検出しました。Issue Scanner を起動します。」

---

## Step 2: Issue Scanner 起動

```
team_recruit({
  role_id: "issue_scanner",
  engine: "claude",
  label: "Issue Scanner",
  description: "全オープンIssueをスキャンしJSON出力する",
  instructions: <references/issue-scanner-instructions.md の内容を埋め込む>
})
```

採用完了後、タスクを割り当てる:

```
team_assign_task({
  assignee: "issue_scanner",
  description: "owner/repo の全オープンIssueをスキャンし、
    .vibe-team/tmp/issue-scan.json に出力してください。
    対象リポジトリ: {owner}/{repo}
    プロジェクトディレクトリ: {project_dir}"
})
```

結果は `team_read({unread_only: true})` で受信する。

### 失敗時のフォールバック

1. `team_dismiss` → 再 `team_recruit(issue_scanner)` → 再度 `team_assign_task`
2. 再失敗 → リーダーが直接 `gh issue list` で取得（フォールバック）

---

## Step 3: issue-scan.json 読取 + バリデーション

`team_read` で issue_scanner の完了報告を受信後、ファイルを読む:

```
Read(.vibe-team/tmp/issue-scan.json)
```

### 必須フィールドのバリデーション

```json
{
  "scan_timestamp": "ISO 8601",
  "repo": "owner/repo",
  "total_open": 15,
  "already_planned": 3,
  "target_issues": [
    {
      "number": 42,
      "title": "...",
      "labels": ["bug"],
      "has_plan_comment": false,
      "complexity_hint": "medium",
      "candidate_files": ["src/foo.ts"],
      "comment_count": 5,
      "body_length": 1200
    }
  ],
  "recommended_worker_count": 2,
  "skipped_issues": [
    { "number": 10, "reason": "planned_label" }
  ]
}
```

バリデーション失敗 → issue_scanner に `team_send` で修正依頼。

---

## Step 4: フィルタリング結果報告

対象0件 → 早期終了（「計画対象のIssueがありません」と報告）。

対象1件以上 → **確認なしで Step 5 へ自動遷移**:

進行宣言例:
```
スキャン完了。対象 {N}件 / スキップ {M}件。
ワーカー {W}名で並列処理を開始します。
```

**禁止**: 「進めてよろしいですか？」「続行しますか？」等の質問形。

---

## Step 5: ワーカー数決定

`recommended_worker_count` を使用（issue_scanner が算出済み）:

| 対象件数 | ワーカー数 |
|---------|-----------|
| 0件 | 処理終了 |
| 1-5件 | 1名 |
| 6-12件 | 2名 |
| 13+件 | 3名 |

3名以上の一括採用時 → HR経由:

```
team_recruit({
  role_id: "hr",
  engine: "claude"
})

team_send("hr", "[Team ← leader] 以下のロールを採用してください:
  plan_writer×3（instructions は以下の通り）:
  <references/plan-writer-instructions.md の内容>")
```

---

## Step 6: plan_writer 採用 → Issue割当

### 直接採用（1-2名の場合）

```
team_recruit({
  role_id: "plan_writer_1",
  engine: "claude",
  label: "Plan Writer 1",
  description: "Issue実装計画の作成・レビュー・投稿",
  instructions: <references/plan-writer-instructions.md の内容を埋め込む>
})
```

### タスク割当（反対端方式）

```
team_assign_task({
  assignee: "plan_writer_1",
  description: "以下のIssueを ID昇順で処理してください:
    #42, #45, #50, #55
    リポジトリ: {owner}/{repo}
    プロジェクトディレクトリ: {project_dir}
    外部LLMモード: {external_llm_mode}
    外部LLMタイムアウト: {external_llm_timeout_ms}ms"
})

team_assign_task({
  assignee: "plan_writer_2",
  description: "以下のIssueを ID降順で処理してください:
    #80, #75, #70, #65
    リポジトリ: {owner}/{repo}
    プロジェクトディレクトリ: {project_dir}
    外部LLMモード: {external_llm_mode}
    外部LLMタイムアウト: {external_llm_timeout_ms}ms"
})
```

---

## Step 7: 全ワーカー完了監視

`team_read({unread_only: true})` で各ワーカーの完了報告を受信。

### 完了報告の期待フォーマット

```
team_send('leader', '完了報告:
  Issue #42: posted (tier=B, score=8, reviewers=3/3, critical=0, final_check=pass, grade=B, external_llm=used/repo_context_only)
  Issue #45: posted (tier=C, score=4, reviewers=2/2, critical=0, final_check=skip, grade=A, external_llm=skipped)
  Issue #50: skipped (already_planned)')
```

### エラー時の対応

1. ワーカーが特定Issueでエラー → `team_assign_task` で別ワーカーに再割当
2. 再割当先もエラー → リーダーが直接処理
3. 3回連続失敗 → 当該Issueをスキップ

---

## Step 8: Tier判定 → ラベル付与

ワーカーの完了報告から各IssueのTier情報を集約:

- Tier A (score ≥ 12) → `fortress-review-required` + `fortress-implement-required` ラベル付与
- Tier B (score ≥ 6) → 追加ラベルなし
- Tier C (score < 6) → 追加ラベルなし

```bash
gh issue edit {number} --repo {owner}/{repo} --add-label "fortress-review-required,fortress-implement-required"
```

---

## Step 9: 完了サマリ → 全メンバー解雇

### 完了レポート出力

```markdown
## Issue Planner 完了レポート

| # | タイトル | Tier | Score | Reviewers | Grade | 外部LLM | Status |
|---|---------|------|-------|-----------|-------|------|--------|
| 42 | ... | B | 8 | 3/3 | B | used | posted |
| 45 | ... | C | 4 | 2/2 | A | skipped | posted |

### サマリ
- 処理: {N}件 / スキップ: {M}件 / エラー: {E}件
- Tier分布: A={a}件, B={b}件, C={c}件
- 外部LLM: used={u}件, skipped={s}件, failed={f}件
- 推定工数合計: {total}h
```

### チームシャットダウン

```
// 各ワーカーに shutdown_request
team_send("plan_writer_1", "shutdown_request")
team_send("plan_writer_2", "shutdown_request")
team_send("issue_scanner", "shutdown_request")

// 確認後 or 30秒待機後に解雇
team_dismiss({ agent_id: "plan_writer_1" })
team_dismiss({ agent_id: "plan_writer_2" })
team_dismiss({ agent_id: "issue_scanner" })
// HR がいれば
team_dismiss({ agent_id: "hr" })
```
