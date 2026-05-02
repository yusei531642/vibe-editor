# パイプライン状態スキーマ定義 — vibe-team版

## ラベル状態機械

```
planned -> implementing -> implemented
   ^         |
   +-- (失敗/中断で戻す)
```

| ラベル | 意味 | 種別 | 色 | 付与元 |
|--------|------|------|-----|--------|
| `planned` | 実装計画が作成済み | 状態 | 緑 `#0E8A16` | vibe-issue-planner / 手動計画投稿 |
| `implementing` | バッチ実装中 | 状態 | 黄 `#FBCA04` | vibe-autopilot-batch |
| `implemented` | 実装完了・E2E通過 | 状態 | 青 `#0075CA` | vibe-autopilot-batch |
| `implementation-failed` | 自動実装失敗 | 属性 | 赤 `#D73A4A` | vibe-autopilot-batch |
| `regression` | リグレッション検出 | 属性 | 赤 `#B60205` | vibe-autopilot-batch |
| `found-during-e2e` | E2E中に発見された既存バグ | 属性 | 橙 `#E4E669` | vibe-autopilot-batch |
| `fortress-review-required` | fortress-review 必須 | 属性 | 紫 `#7057FF` | vibe-issue-planner（Tier A判定時） |
| `fortress-implement-required` | fortress-implement 必須 | 属性 | 紫 `#5319E7` | vibe-issue-planner（実装複雑度I2+） |

**ルール**: 状態ラベルは常に1つのみ。属性ラベルは状態ラベルと併用可能。

---

## パイプライン状態ファイル（SSoT）

`.vibe-team/tmp/batch-pipeline-state.json` がSingle Source of Truth。
`state_keeper` が管理し、各セーフポイントで更新する。

```json
{
  "version": "1.0",
  "mode": "all-planned",
  "batch_id": "vibe-batch-20260502-1200",
  "repo": "owner/repo",
  "terminal_budget": 5,
  "execution_order": [11, 14, 13, 15],
  "issues": [
    {
      "number": 11, "title": "Auth API", "phase": "B_completed",
      "pr_number": 45, "branch": "feat/issue-11-auth",
      "tier": "B",
      "tier_score": 8,
      "fortress_review_result": null,
      "changed_files": ["src/auth.ts", "src/api/login.ts"],
      "e2e_result": "PASS", "retry_count": 0,
      "e2e_test_items": ["ログイン画面", "認証API"],
      "e2e_report": {
        "summary": { "total": 3, "passed": 3, "failed": 0, "skipped": 0 },
        "core_operation_tested": true,
        "deploy_verified": true,
        "has_l2_test": true
      },
      "worker_summary": "src/auth.ts のインポート順序を変更。#14との競合注意。",
      "coderabbit_status": "PASS",
      "processed_events": ["phaseA_complete", "coderabbit_checked", "phaseB_e2e_pass"],
      "phase_a_worker_id": "implementer_11",
      "phase_b_worker_id": "e2e_tester_11"
    }
  ],
  "context": {
    "error_patterns": [],
    "staging_notes": "",
    "next_action": "#14 merge許可発行 -> #13 ワーカー起動",
    "consecutive_failures": 0
  },
  "current_staging_gate": "none",
  "completed_count": 1, "total_count": 4,
  "discovered_issues": [],
  "processed_events": ["batch_init", "issue_11_phaseA", "issue_11_phaseB"],
  "artifacts": {
    "batch_plan": ".vibe-team/tmp/batch-plan.json",
    "state_file": ".vibe-team/tmp/batch-pipeline-state.json"
  },
  "team_members": {
    "state_keeper": "state_keeper_0",
    "active_phase_a": null,
    "active_phase_b": "e2e_tester_14"
  }
}
```

## フィールド説明

| フィールド | 型 | 目的 |
|-----------|-----|------|
| `issues[].worker_summary` | string | ワーカー報告の1行要約。競合注意点・特記事項 |
| `issues[].e2e_report` | object | E2E報告の要約版 |
| `issues[].tier` | string/null | "A"/"B"/"C"/null。null時Tier B扱い |
| `issues[].tier_score` | number/null | Tier判定スコア |
| `issues[].fortress_review_result` | string/null | "Go"/"No-Go"/"条件付きGo"/"skipped"/null |
| `issues[].processed_events` | string[] | 冪等性保証。処理済みイベントを記録 |
| `issues[].coderabbit_status` | string | PASS/FIXED/TECH_DEBT/SKIPPED |
| `issues[].phase_a_worker_id` | string | Phase Aワーカーの team_recruit ID |
| `issues[].phase_b_worker_id` | string | Phase Bワーカーの team_recruit ID |
| `context.error_patterns` | string[] | 発見パターン（最大5件、FIFO） |
| `context.next_action` | string | **最重要** — 次に何をすべきか即座に把握 |
| `context.consecutive_failures` | number | 連続失敗カウント（B4連携） |
| `team_members` | object | 現在アクティブなワーカーIDを追跡 |

**更新タイミング**: Phase A完了時、Phase B完了時、Issue完了時の各セーフポイントで必ず更新。

---

## resumeモードの復元手順

1. `.vibe-team/tmp/batch-pipeline-state.json` を Read
2. `context.next_action` を確認 -> 次のアクションを即座に把握
3. `context.error_patterns` を確認 -> 蓄積された学習を復元
4. 各 issue の `phase` + `processed_events` を確認 -> 現在位置を特定
5. GitHub実状態照合:
   phase が "A_completed" かつ e2e_result が null のIssueについて:
   `gh pr view` + `gh issue view` でGitHub実状態を確認し、
   全完了済みなら B_completed + e2e_result: "PASS" に自動補正
6. `implementing` ラベルのIssueを特定し、状態ファイルのphaseと照合
7. 必要なワーカーを `team_recruit` で再採用（Phase A未完了 -> implementer、Phase A完了 -> e2e_tester）
8. 既完了Issueの `worker_summary` + PR番号・変更ファイルをバッチコンテキストとして復元
