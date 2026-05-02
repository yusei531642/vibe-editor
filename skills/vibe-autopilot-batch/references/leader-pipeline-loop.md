# リーダーワークフロー: Step 7（パイプライン実行ループ）— vibe-team版

## 7-pre. コンテキスト復元ガード（各イテレーション冒頭、必須）

パイプラインループの各イテレーション開始時:
1. `.vibe-team/tmp/batch-pipeline-state.json` を Read する
2. `context.next_action` を確認し、次のアクションを把握する
3. 各 issue の `phase` と `processed_events` を確認し、現在位置を特定
4. GitHub実状態照合（ワーカー未応答リカバリ）:
   phase が "A_completed" かつ e2e_result が null のIssueについて:
   a. `gh pr view <PR番号> --json state,mergedAt` -> MERGED なら staging merge 完了
   b. `gh issue view <番号> --json state` -> CLOSED なら Issue close 完了
   c. 両方 true -> 状態ファイルを B_completed + e2e_result: "PASS" に補正
   d. Issueコメントから E2E結果を抽出して worker_summary を補完
   e. processed_events に "phaseB_e2e_pass" を追加
   f. ラベルを implementing -> implemented に更新、completed_count をインクリメント
   g. ログ出力: 「Issue #{番号}: ワーカー未応答 -- GitHub実状態から B_completed に自動補正」

#### GitHub実状態照合の補正テーブル

| 状態ファイル | GitHub PR | GitHub Issue | 補正アクション |
|-------------|-----------|-------------|--------------|
| A_completed | MERGED | CLOSED | -> B_completed に補正、ラベルを implemented に更新 |
| A_completed | MERGED | OPEN | -> Phase B途中。E2E未実施の可能性。Phase Bワーカー再起動 |
| A_completed | OPEN | OPEN | -> 正常。Phase B開始待ち |

5. 上記の情報に基づいて処理を継続する

## 7-pre. サブエージェント遅延時の並行調査

`team_assign_task` で起動した調査ワーカーが **60秒以上** 応答しない場合:
- リーダーは応答を待たず、**直接コード読み込み・`gh issue view`等で並行調査**を開始
- ワーカーの結果が `team_read` で後から届いた場合はリーダーの調査結果と統合
- ワーカーの完了を待たずに結論を出せるなら先に出す

---

## 7a. Issue[N] のワーカー起動（Phase A）

1. `implementing` ラベル付与（原子的に実行）:
   ```bash
   gh issue edit {number} --repo owner/repo --add-label "implementing" --remove-label "planned"
   ```

2. vibe-shared-roles から implementer の instructions を Read:
   ```
   Read("../vibe-shared-roles/references/role-instructions/implementer.md")
   ```

3. ワーカー採用 + バッチコンテキスト注入:
   ```
   team_recruit({
     role_id: "implementer",
     engine: "claude",
     label: "実装者 #{number}",
     description: "Issue #{number} Phase A実装",
     instructions: "{implementer基本instructions}\n\n
       ## バッチコンテキスト\n
       - Issue番号: #{number}\n
       - Tier: {tier} (スコア: {tier_score})\n
       - レビューレーン数: {review_lane_count}\n
       - 変更済みファイル一覧: {changed_files}\n
       - 競合注意: {conflict_notes}\n
       - E2Eヒント: {e2e_test_hints}\n
       - fortress-review-required: {true/false}\n
       - fortress-implement-required: {true/false}"
   })
   ```

4. タスク割当:
   ```
   team_assign_task("implementer_{number}", "Issue #{number} のPhase Aを実行せよ")
   ```

**Tier情報注入**: `.vibe-team/tmp/batch-plan.json` から tier/tier_score を読み取り
**レビューレーン数**: Tier C->2、Tier B/A->5、null->5
**fortress-review-required ラベル検知**: `gh issue view {number} --json labels --jq '.labels[].name'`

---

## 7b. Issue[N] ワーカーからPhase A完了報告を受信

`team_read({unread_only: true})` で Phase A完了報告を受信後:

- **冪等性チェック**: `processed_events` に `"phaseA_complete"` が含まれていれば -> スキップ
- **クアドレビュー数値ゲート検証**:
  1. 当該Issueの `tier` を batch-plan.json から確認
  2. 期待分母: Tier C -> 2、Tier B/A -> 5、null -> 5
  3. `review_lanes_completed` が `{期待分母}/{期待分母}` であること
  4. `critical_open=0` であること
  5. Phase 1 未達 -> merge許可保留
- **実装計画カバレッジ検証（必須）**:
  1. `plan_steps_covered` を確認
  2. batch-plan.json の計画ステップ数と照合
  3. GitHub APIで実照合:
     ```bash
     gh issue view <番号> --comments
     gh pr diff <PR番号> --name-only
     ```
  4. 全ステップ未カバー -> ワーカーに追加実装指示（merge許可保留）
- `state_keeper` に状態更新を委任: phase -> "A_completed"、pr_number、changed_files 記録
- `.vibe-team/tmp/issue-{N}-phase-a-summary.md` を作成（Phase Bワーカーへの引き継ぎ）

## 7b-post. CodeRabbitレビュー確認（Phase A完了直後、必須）

- **冪等性チェック**: `processed_events` に `"coderabbit_checked"` が含まれていれば -> スキップ
- `gh pr checks <PR番号> --watch` でCodeRabbit check完了まで待機
- soft gate。ただし **セキュリティ/バグ指摘は hard block**
- 指摘の3分類: 即時修正(`FIXED`) / 技術的負債Issue化(`TECH_DEBT`) / スキップ(`SKIPPED`)
- `coderabbit_status` 未確定のまま mergeゲート判定に進めてはならない

## 7b-post2. fortress-review 完了確認（Tier A のみ）

- **条件**: tier == "A" の場合のみ
- `fortress_review_result == "Go"` or `"条件付きGo"` -> mergeゲート判定に進む
- `fortress_review_result == "No-Go"` -> ユーザー判断を仰ぐ
- `fortress_review_result` なし -> ワーカーにvibe-fortress-review実行を指示

---

## 7c. staging mergeゲート判定（原子的に実行）

- 前Issue[N-1]のE2Eが通過済み -> Issue[N]にmerge許可トークン送信
- 前Issue[N-1]のE2E未完了 -> 許可保留

### 7c-post. merge許可送信直後のリーダー継続義務

merge許可 `team_send` 後、リーダーは以下を即時実行:

1. 状態ファイル更新: `context.next_action` を設定
2. **核心ルール17**: Phase Bは新規ワーカーを `team_recruit(e2e_tester)` で採用:
   ```
   team_recruit({
     role_id: "e2e_tester",
     engine: "claude",
     label: "E2Eテスター #{number}",
     description: "Issue #{number} Phase B",
     instructions: "{e2e_tester基本instructions}\n\n
       ## Phase A サマリ\n
       {.vibe-team/tmp/issue-{N}-phase-a-summary.md の内容}"
   })
   team_assign_task("e2e_tester_{number}", "merge許可済み。Step 11-17を実行せよ")
   ```
3. 次IssueのPhase Aワーカーが未起動なら即座に 7d を実行
4. 次Issueが起動済みなら 7-pre に戻る

### リーダー側ASSERT_NEXT連鎖

```
Step 7c merge許可 team_send 送信
  -> ASSERT_NEXT: "7c-post: state更新 + Phase B新ワーカー team_recruit"
  -> ASSERT_NEXT: "7d: 次Issue Phase Aワーカー起動判定"
  -> ASSERT_NEXT: "7-pre: state再Read + next_action確認"
```

この区間で「応答待ち」「受信待ち」を理由に停止してはならない。

---

## 7d. 次Issue[N+1]のワーカー起動 + バッチコンテキスト更新

1. 状態ファイルから既変更ファイル一覧を読取
2. batch-plan.json から次Issueの `conflict_notes`, `e2e_test_hints`, `tier`, `tier_score` を読取
3. レビューレーン数決定（Tier基準）
4. fortress-review-required ラベル検知
5. `team_recruit(implementer)` + `team_assign_task` でワーカー起動
6. E2E失敗でスキップされたIssueの変更ファイルは一覧から除外

---

## 7e. E2E通過通知を受けたら

`team_read` で Phase B完了報告を受信後:

- **冪等性チェック**: `processed_events` に `"phaseB_e2e_pass"` / `"phaseB_e2e_fail"` が含まれていれば -> スキップ
- **E2E報告ゲート検証（B14ガードレール）**
- 状態ファイル更新: phase -> "B_completed"、e2e_result を記録
- Issue[N]に `implemented` ラベル付与 + Issueクローズ
- 待機中のIssue[N+1]があればmerge許可トークンを `team_send`
- Phase Bワーカーを `team_dismiss` で解放

### 7e-post. E2Eリレー出力（必須、ガードレールB20）

ワーカーのE2E報告は `team_send` 内で完結するため、Stop Hookが検知できない。
リーダーは7eのゲート検証完了後、以下のJSON形式サマリを **自身のstdout** に出力:

```
--- E2Eテスト結果リレー（Issue #{番号}） ---
{
  "e2e_result": "{PASS|FAIL}",
  "summary": { "passed": {n}, "failed": {n}, "skipped": {n} },
  "core_operation": { "tested": {true|false} },
  "deploy_verification": { "performed": {true|false} },
  "confidence_gate": {
    "C1": "worker_answered", "C2": "worker_answered",
    "C3": "worker_answered", "C4": "worker_answered",
    "C5": "worker_answered", "C6": "leader_pending"
  }
}
--- E2Eテスト結果リレー終了 ---
```

### 7e-post-gui. proxy=code_path_integrity 時のGUI確認依頼（必須）

ワーカーE2E報告の `proxy_used` が `"code_path_integrity"` の場合、
Issueクローズコメント末尾に「ユーザー手動GUI確認依頼」ブロックを追加してから `gh issue close` する。

---

## 7f. 進捗レポート更新

```
バッチ実装進捗レポート（パイプライン方式）

| # | Issue | タイトル | 工数 | Phase | ステータス | PR |
|---|-------|---------|------|-------|----------|-----|
| 1 | #11   | Auth API | M   | B完了  | E2E PASS | #45 |
| 2 | #14   | Dashboard | S  | B実行中 | E2E中  | #46 |
| 3 | #13   | Payment  | L   | A実行中 | 実装中  | -   |

経過時間: 45分 | 完了: 1/3 | 発見不具合: 0件
```

## 7g. Issue間クールダウン（60秒）

- 各IssueのPR作成後、次PR作成まで最低60秒空ける（CodeRabbitレート制限回避）
- 待機中も状態ファイル更新・ログ出力は可。新規PR作成・ワーカー起動は保留

## 7g-post. Compaction検知時のコンテキストリセット推奨

Compaction発生時は `/clear` + resume を推奨するメッセージをユーザーに出力。
ユーザーが続行を選択した場合はそのまま継続（強制停止しない）。

## 7h. ワーカーidle検知と自動リカバリ

**idle通知3回ルール:**
- ワーカーが `team_send` でidle通知を3回以上連続送信 -> コンテキスト飽和と判断
- `team_dismiss` で該当ワーカーを解放し、新規 `team_recruit` で再起動
- Phase A idle -> 新ワーカーでPhase A再実行
- Phase B idle -> 新ワーカーでPhase B実行（Phase A summary読み込みから開始）

**長期未応答リカバリ（3分岐）:**

| 条件 | 状態 | アクション |
|------|------|----------|
| PR merged + Issue closed | 全完了 | B_completed に補正、次Issueのmerge許可発行 |
| PR merged + Issue open | E2E結果不明 | 新ワーカーでE2Eテストから再実行 |
| PR not merged | Phase B未開始/途中 | 冪等リカバリ手順を適用 |
