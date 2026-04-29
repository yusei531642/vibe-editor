---
name: issue-autopilot-batch
description: |
  planned ラベル付きIssueを順次自律実装するバッチパイプライン。
  issue-plannerの出力を入力として、各Issueをissue-flowの品質基準で
  順次実装し、stagingの安定性を保ちながらバッチ処理する。
  トリガー: "issue-autopilot-batch", "バッチ実装", "一括実装", "全issue実装",
  "planned issues実装", "バッチオートパイロット", "一括オートパイロット"
  使用場面: (1) planned済みIssueの順次自律実装、(2) スプリントバックログの一括消化、
  (3) マイルストーン内Issueの集中処理、(4) issue-plannerの後続パイプライン
---

# Issue Autopilot Batch スキル

> **取り込み元**: Google Drive `issue-autopilot-batch` フォルダ
> (folderId: `13u16jHAJFXmc1-Cd6qJBkqZUUlq6-H2V`)。
> 完全版の `references/*.md` と `lessons/*.md` は Drive 側に格納されており、
> 本リポジトリには SKILL.md(本ファイル) と読み込み手順のみを置く軽量導入。
> 実際のフロー実行で各 reference が必要になったら `mcp__*__read_file_content`
> で都度取得する (skill 自体が「オンデマンド Read」設計)。

## 概要

`planned` ラベル付きIssueを **パイプライン逐次実行** で自律実装するバッチスキル。
issue-planner(計画) → **issue-autopilot-batch(一括実装)** → staging安定 → main PR の流れ。

```
planned Issue群 → 順序決定 → [フェーズA: 実装~レビュー | フェーズB: staging~E2E] → 回帰テスト → main PR
                              パイプライン: E2E待ち時間に次Issueの実装を開始
```

### パフォーマンス参考値

| 指標 | 実績値 | 備考 |
|------|--------|------|
| バッチスループット | 5 Issue/hour | fix 4件 + feat 1件で約66分 |
| 個別Issue平均 | 約13分/Issue | PR作成〜stagingマージ |
| ボトルネック | E2Eテスト・デプロイ待ち | パイプライン並列で吸収 |

**Tier別処理時間の差異:**

| Tier | レビューレーン数 | 個別Issue平均 | 備考 |
|------|----------------|-------------|------|
| C (< 6) | 2レーン | 約9分/Issue | 低リスク: Codex + 仕様準拠のみ |
| B (>= 6) | 5レーン | 約13分/Issue | 現行基準(変更なし) |
| A (>= 12) | 5レーン + fortress-review | 約18分/Issue | 実装前にfortress-review(約5分追加) |

## トリガー条件

- `/autopilot-batch` コマンド
- 「バッチ実装」「一括実装」「全issue実装」等のキーワード
- issue-planner 完了後の後続パイプラインとして

## 入力形式

| 形式 | 例 | 説明 |
|------|-----|------|
| Issue番号リスト | `/autopilot-batch #10 #11 #12` | 指定Issueのみ実装 |
| planned全件 | `/autopilot-batch all-planned` | planned全件を自動取得 |
| マイルストーン | `/autopilot-batch milestone:v2.0` | 特定マイルストーン内のplanned |
| 中断再開 | `/autopilot-batch resume` | 状態ファイルから再開 |

**バッチサイズ制限: 1バッチ最大5 Issue** (コンテキスト飽和防止)。超える場合はバッチを分割。

---

## 核心ルール (要約 19項目)

1. **フェーズA/B分離**: A=実装~PR~レビュー、B=staging merge~E2E~クローズ。フェーズA並列は最大1、Bは同時1のみ。
2. **ラベル状態機械**: `planned` → `implementing` → `implemented` (常に1つだけ)。失敗時は `planned` + `implementation-failed`。
3. **状態ファイル唯一の真実源**: `tasks/batch-pipeline-state.json` がSSOT。
4. **コンテキスト復元ガード(B11)**: 各イテレーション冒頭で状態ファイルRead、`context.next_action` で次アクション把握。
5. **mergeゲートの原子性**: 前IssueのE2E通過後にのみ次Issueのstaging mergeを許可。
6. **実装計画カバレッジ検証**: フェーズA完了報告で `plan_steps_covered` を確認。PRマージ=実装完了 ではない。
7. **冪等性保証(B13)**: `processed_events` で二重処理防止。
8. **E2E不具合分類**: REQUIREMENT / REGRESSION / PRE-EXISTING / FLAKY-INFRA の4種別。
9. **Batch Planning Agentへの委任**: リーダーはIssue詳細/実装計画を直接読まずサブエージェントに委任。
10. **バッチ完了定義**: 本番E2E確認PASSをもってバッチ完了。Release PR承認依頼で止まらず本番デプロイまで一気通貫。
11. **E2E報告構造化必須**: フェーズB E2E報告はJSON構造化スキーマ必須。リーダーは8項目のゲート検証。コアオペレーション直接テスト自問。
12. **ASSERT_NEXT(自動継続アサーション)**: 該当Step完了後は即時次Stepを実行する義務。途中停止はB15違反。
13. **クアドレビュー数値ゲート(必須、Tier別分母)**: `review_lanes_completed={N}/{N}` かつ `critical_open=0` をフェーズA完了の前提。
14. **Issueクローズ完了監査**: `## E2E結果` と `## クローズ根拠` をIssueコメントに投稿してからクローズ。
15. **CodeRabbitレビュー確認(Phase A完了後必須)**: `gh pr checks <PR> --watch` でCodeRabbit完了まで待機。セキュリティ/バグ指摘はhard block。
16. **Tier判定統合(fortress-review/fortress-implement連携)**: `fortress-review-required` ラベル付きは実装前に fortress-review 自動実行。
17. **Phase B専用ワーカー原則**: Phase A完了後、同一ワーカーをPhase Bに再利用しない。Phase A summaryで新ワーカーが即開始可能。
18. **Grok research lane は補助用途限定**: planning/review/risk synthesisの補助レーンに限定、merge/E2E/Issue closeなど実行系には使わない。
19. **Phase Bワーカー条件付きASSERT_NEXT自動継続**: merge許可SendMessage受信時、Step 11~17を単一の連鎖として自動実行。「待機中は何もしない」は禁止表現。

---

## リーダーワークフロー (13ステップ)

| Step | 内容 |
|------|------|
| 0 | **ゲートキーパー(早期終了判定)**: planned 0件なら即終了 |
| 1 | 入力解析 + resumeチェック |
| 2 | Batch Planning Agent 起動 (サブエージェントに委任) |
| 3 | batch-plan.json 読み取り + バリデーション |
| 5 | ユーザーに実行計画を提示 |
| 6 | チーム作成 + 状態ファイル初期化 |
| 7 | パイプライン実行ループ (7a-7h: 復元ガード+未応答リカバリ+E2Eリレー出力+Compaction時 `/clear` 推奨) |
| 8 | 全Issue完了サマリ + 統合回帰テスト |
| 9 | staging→main PR作成 |
| 10 | mainマージ承認 → 自動継続 (vercel-watch → 本番E2E) |
| 11 | 完了報告 + TeamDelete |
| 12 | クリーンアップ |

## ワーカーフロー概要 (Phase A/B)

- **Phase A** (Step 0-10): ラベル確認 → fortress-review(Tier A) → Issue読込 → 実装 → PR → クアドレビュー → 完了報告
- **Phase B** (Step 11-17): merge許可待ち → rebase → staging merge → E2E → クローズ

報告は2回のみ: Phase A完了時 + Phase B E2E結果(JSON構造化必須)。

---

## ガードレール (30項目要約)

B1(mergeゲート)/B2(post-rebase品質)/B3(ラベル状態機械)/B4(連続失敗制限)/B5(セーフポイント)/
B6(APIレート防御)/B7(途中mainマージ禁止)/B8(リーダー専念)/B9(並列制限)/B10(統合回帰)/
B11(復元ガード)/B12(error_patterns上限)/B13(冪等性)/B14(E2E報告ゲート検証)/B15(ASSERT_NEXT停止禁止)/
B16(自信ゲート C1~C5の5問必答)/B17(変更箇所カバレッジ change_coverage_map必須)/
B18(ブラウザ外操作制約 browser_boundary必須)/B19(CodeRabbit確認ゲート)/
B20(E2Eリレー出力)/B21(fortress-review必須ゲート)/B22(過剰品質ゲート禁止)。

## 主要アンチパターン

- 複数Issueの同時staging merge禁止
- implementing ラベルなしの実装開始禁止
- リーダーの直接実装介入禁止
- PRマージ=実装完了 と見なすことの禁止
- Issueコメント未読での実装開始禁止
- #20: ASSERT_NEXT句で停止してユーザー報告のみ行う
- #21: E2E結果を自由テキストで報告する
- #22: core_operation 未テストでPASS判定
- #24: 自信ゲート未回答でE2E報告 (C1〜C5の5問必答)
- #28: E2Eテスト通過数のみでカバレッジ判定 (#1534教訓)
- #30: CodeRabbitレビュー未完了で staging merge を実行
- #31: ワーカーE2E結果を受領してもリーダー stdout にリレー出力しない
- #32: fortress-review-required ラベル付き Issue を fortress-review なしで実装開始
- #34: ワーカーが issue-flow の自動継続で merge許可前に staging merge する

---

## オンデマンドRead指示 (必要なStepに到達したら参照する)

完全版の reference は Google Drive folder `13u16jHAJFXmc1-Cd6qJBkqZUUlq6-H2V` 配下にある。
`mcp__*__read_file_content` (該当 Drive fileId) で取得すること。

| Step | Read対象 | Drive fileId |
|------|---------|--------------|
| 1 (resume) | references/pipeline-state-schema.md | `1MfHtGyhCTDDyjzeV3wdWBo1GP0jeqlaI` |
| 2 | references/batch-planning-agent.md | `1ft9hB6QLZ40tDv9fhP8Sf5JkJKrugmfD` |
| 3-6 | references/leader-steps-1-6.md | `1wm5Lhzu9ktkK8Us1WMrXVz2_1ZFtsLKq` |
| 6, 10 | references/leader-core-invariants.md | `1ZQovt4z-zEoPh1b_ZLoYxwzCf0n0Z196` |
| 7開始 | references/leader-pipeline-loop.md | `1WQuad_R_ar_3o8zloiW8CPZTe6oiFDGr` |
| 7a/7d | references/worker-prompt-template.md | `1z_nHO8kKNpbkDNRv_oMeXGHodqmsZY21` |
| 7e | references/e2e-report-schema.md | `1f8SVjirf1xuHSC5cLstx3IVRnnyvdPRI` |
| 7e | references/e2e-defect-classification.md | `1ujCsqkY5y5J2oBhYmQ9z1i98m_iYuvko` |
| 8-12 | references/leader-steps-8-12.md | `1pD0nwtkgAmpeecpeApwV_J6riqKk2c_E` |
| Phase A/B 詳細 | references/worker-flow.md | `1wR3eQk5OKCsoBohn_6Idvw2CIf9Nu8Rz` |
| 全体 | references/leader-workflow.md | `125LDQn2pc36I9dfjWaeQ7oXBFycoVGFd` |
| Tier別レビュー | references/multi-perspective-review.md | `197fTT-1PoWhE_5vmuxMHOlnffPxEWMVG` |
| Grok lane | references/grok-research-lane.md | `1TxsZapqHsuXZ0V06oW_hYoZF9g_9LhhJ` |
| エラー時 | references/troubleshooting.md | `16bjPkvX2hEf2hfk7eDEh44Ru622AIBAu` |
| ガードレール詳細 | references/guardrails-antipatterns.md | `18AZUq0Ob4-dia9shA9m_suwfV7CYOjhi` |
| 教訓 | lessons/batch-20260422-1506.md | `104kJGRLOcIW8IYsNiFppLnTDWvT59gxT` |

---

## クイックスタート

1. `planned` ラベル付きIssueを準備 (issue-plannerで作成 or 手動)
2. `/autopilot-batch all-planned` でバッチ起動
3. **ゲートキーパー**: planned Issue 0件なら即終了
4. Batch Planning Agent が分析・計画策定 → batch-plan.json 生成
5. ユーザーが実行計画を確認
6. パイプライン実行ループ(自動)
7. 全Issue完了 → 統合回帰テスト → staging→main PR作成
8. ユーザーがRelease PR承認
9. mainマージ → 本番デプロイ監視 → 本番E2E確認 → 完了報告

## vibe-editor 適用上の注意

- vibe-editor リポジトリの CLAUDE.md は **「main 直 push 禁止 / 必ず Issue → branch → PR → bot レビュー → 自動 merge」** ルール。skill の Step 9-10 (staging→main PR) は vibe-editor では **vibe-editor-reviewer (bot)** が自動 merge する流れに置き換えること。
- vibe-editor では `staging` ブランチを使わず main 1本構成。Phase B の "staging merge" は **PR を bot に merge してもらう** に読み替える。
- E2E は Tauri ベースのデスクトップアプリ性質上、UI 自動テスト基盤が薄い。`npm run typecheck` + `npm run build` (= `cargo tauri build`) を必須ゲートとして扱い、UI 動作は手動確認の旨を E2E 報告に明記する。

## 関連スキル

| スキル | 関連 |
|--------|------|
| `pullrequest` | vibe-editor の PR ワークフロー(本リポ専用) — bot レビュー → 自動 merge |
| `vibeeditor` | vibe-editor プロジェクト全体ガイド |
| `claude-design` | UI リファインのデザインガイド |
| `vibe-team` | マルチエージェント機能 |
