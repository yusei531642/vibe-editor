---
name: vibe-autopilot-batch
description: |
  vibe-teamで planned ラベル付きIssueを順次自律実装するバッチパイプライン。
  vibe-editor Canvas版。issue-autopilot-batch の vibe-team MCP 翻訳。
  Phase A/B分離パイプライン、State Keeper による SSoT管理、
  fortress スキル自動トリガー、resume機能を vibe-team フローで実装。
  トリガー: "vibe-autopilot-batch", "vibeバッチ実装", "canvasバッチ", "vibe一括実装"
  使用場面: (1) planned済みIssueの順次自律実装、(2) スプリントバックログの一括消化、
  (3) マイルストーン内Issueの集中処理、(4) vibe-issue-plannerの後続パイプライン
---

# vibe-autopilot-batch

## 概要

`planned` ラベル付きIssueを **vibe-team MCP** でチームを動的に編成し、
**パイプライン逐次実行**で自律実装するバッチスキル。
vibe-issue-planner（計画） -> **vibe-autopilot-batch（一括実装）** -> staging安定 -> main PR の流れ。

```
planned Issue群 -> 順序決定 -> [Phase A: 実装~レビュー | Phase B: staging~E2E] -> 回帰テスト -> main PR
                              パイプライン: E2E待ち時間に次Issueの実装を開始
```

### パフォーマンス参考値

| 指標 | 実績値 | 備考 |
|------|--------|------|
| バッチスループット | 5 Issue/hour | fix 4件 + feat 1件で約66分 |
| 個別Issue平均 | 約13分/Issue | PR作成~stagingマージ |
| ボトルネック | E2Eテスト・デプロイ待ち | パイプライン並列で吸収 |

**Tier別処理時間:**

| Tier | レビューレーン数 | 個別平均 | 備考 |
|------|----------------|---------|------|
| C (< 6) | 2レーン | 約9分 | 低リスク: Codex + 仕様準拠のみ |
| B (>= 6) | 5レーン | 約13分 | 現行基準 |
| A (>= 12) | 5レーン + vibe-fortress-review | 約18分 | 実装前にfortress-review（約5分追加） |

## トリガー条件

- `/vibe-autopilot-batch` コマンド
- 「vibeバッチ実装」「vibe一括実装」「canvasバッチ」等のキーワード
- vibe-issue-planner 完了後の後続パイプラインとして

## 入力形式

| 形式 | 例 | 説明 |
|------|-----|------|
| Issue番号リスト | `/vibe-autopilot-batch #10 #11 #12` | 指定Issueのみ実装 |
| planned全件 | `/vibe-autopilot-batch all-planned` | planned全件を自動取得 |
| マイルストーン | `/vibe-autopilot-batch milestone:v2.0` | 特定マイルストーン内のplanned |
| 中断再開 | `/vibe-autopilot-batch resume` | 状態ファイルから再開 |

**バッチサイズ制限: 1バッチ最大5 Issue**（コンテキスト飽和防止）。超える場合はバッチを分割。

---

## 差異マッピングテーブル（Agent Teams -> vibe-team MCP）

| issue-autopilot-batch (Agent Teams) | vibe-autopilot-batch (vibe-team MCP) |
|---|---|
| `Agent(subagent_type=general-purpose)` | `team_recruit(role_id, engine, instructions)` |
| `Agent(Bash: codex exec)` | `team_recruit(engine: "codex")` + `team_assign_task` |
| Batch Planning Agent (サブエージェント) | `team_recruit(codex_scout)` + `team_assign_task` |
| ワーカー起動（Agent tool） | `team_recruit(implementer)` + `team_assign_task` |
| Phase B ワーカー（新規Agent） | `team_recruit(e2e_tester)` + `team_assign_task` |
| SendMessage（merge許可） | `team_send(worker_id, "merge許可: ...")` |
| ワーカー完了報告 | `team_send('leader', "完了報告: ...")` |
| TeamCreate | `team_recruit`（ロール定義+採用を1コールで） |
| TeamDelete | `team_dismiss(agent_id)` で全メンバー解散 |
| TaskCreate / TaskGet | `team_assign_task` / `team_get_tasks` |
| `tasks/batch-pipeline-state.json` | `.vibe-team/tmp/batch-pipeline-state.json` |
| `tasks/batch-plan.json` | `.vibe-team/tmp/batch-plan.json` |
| `tasks/issue-{N}-phase-a-summary.md` | `.vibe-team/tmp/issue-{N}-phase-a-summary.md` |
| 並列Agent起動（1メッセージ複数Agent） | `team_assign_task` を連続呼出 |

---

## チーム編成計画

### 固定メンバー
- **Leader**: オーケストレーション、パイプライン制御、mergeゲート管理（engine: claude）

### 動的メンバー（パイプライン進行に応じて採用・解散）

| role_id | engine | label | 責務 | 採用タイミング |
|---------|--------|-------|------|-------------|
| `state_keeper` | codex | 状態管理者 | batch-pipeline-state.json 管理・resume | Step 6（初期化時） |
| `codex_scout` | codex | 偵察員 | Batch Planning Agent（計画策定） | Step 2 |
| `implementer` | claude | 実装者 | Phase A: Issue実装・PR作成・レビュー | Step 7a（Issue毎） |
| `e2e_tester` | claude | E2Eテスター | Phase B: staging merge・E2E・クローズ | Step 7c-post（Issue毎） |
| `codex_final_checker` | codex | 最終検証者 | 統合回帰テスト | Step 8 |

### 採用ルール
- ロール定義は `vibe-shared-roles/SKILL.md` + `references/role-instructions/` から Read
- 7±2ルール: 同時最大5体（Leader直轄でOK）
- Phase A完了後、**同一ワーカーをPhase Bに再利用しない**（核心ルール17）
- Phase B用に `e2e_tester` を新規 `team_recruit` する

---

## リーダーワークフロー概要（13ステップ）

| Step | 内容 | vibe-team操作 |
|------|------|-------------|
| 0 | ゲートキーパー（planned 0件→即終了） | — |
| 1 | 入力解析 + resumeチェック | — |
| 2 | Batch Planning Agent 起動 | `team_recruit(codex_scout)` → `team_assign_task` |
| 3 | batch-plan.json 読取 + バリデーション | `team_read` → ファイル Read |
| 4 | （欠番、Step 3に統合） | — |
| 5 | ユーザーに実行計画を提示 | — |
| 6 | state_keeper 採用 + 状態ファイル初期化 | `team_recruit(state_keeper)` |
| 7 | パイプライン実行ループ（7a-7h） | 詳細: references/leader-pipeline-loop.md |
| 8 | 全Issue完了サマリ + 統合回帰テスト | `team_recruit(codex_final_checker)` |
| 9 | staging->main PR作成 | — |
| 10 | mainマージ承認 → vercel-watch → 本番E2E | — |
| 11 | 完了報告 + 全メンバー解散 | `team_dismiss` ×全員 |
| 12 | クリーンアップ（アーカイブ + ブランチ整理） | — |

詳細: references/leader-pipeline-loop.md

## ワーカーフロー概要（Phase A/B）

- **Phase A**（implementer）: ラベル確認 → fortress-review(Tier A) → Issue読込 → 実装 → PR → クアドレビュー(Tier別) → `team_send('leader', "Phase A完了: ...")`
- **Phase B**（e2e_tester、新規採用）: merge許可受信 → rebase → staging merge → E2E → Issueクローズ → `team_send('leader', "Phase B完了: ...")`
- 報告は2回: Phase A完了時（`review_lanes_completed` / `critical_open` 必須）+ Phase B E2E結果（JSON構造化必須）

---

## 核心ルール（21項目）

### 1. Phase A/B分離（パイプラインの要）
- **Phase A**（staging不要）: 実装 → lint → build → PR作成 → クアドレビュー
- **Phase B**（staging依存）: staging merge → deploy → E2E → Issueクローズ
- Phase A並列は最大1つ。Phase Bは同時に1つのみ

### 2. ラベル状態機械
- `planned` → `implementing` → `implemented`（状態ラベルは常に1つのみ）
- 失敗/中断時は `planned` + `implementation-failed` に戻す
- 詳細: references/pipeline-state-schema.md

### 3. 状態ファイル = 唯一の真実源（SSoT）
- `.vibe-team/tmp/batch-pipeline-state.json` がSingle Source of Truth
- `state_keeper` が各セーフポイントで更新。resumeはこのファイルのみで復元
- ワーカー未応答時はGitHub実状態との照合で補正（B11ガードレール）

### 4. コンテキスト復元ガード（B11ガードレール）
- パイプラインループ各イテレーション冒頭で状態ファイルを必ずRead
- `context.next_action` で次のアクションを把握
- A_completed かつ e2e_result=null に対しGitHub実状態を照合し自動補正

### 5. mergeゲートの原子性
- 前IssueのE2E通過後にのみ次Issueのstaging mergeを許可
- 1 Issue に対し1回限りのmerge許可トークン（再利用不可）

### 6. 実装計画カバレッジ検証（必須）
- ワーカーのPhase A完了報告で `plan_steps_covered` を確認
- 全ステップ未カバーなら追加実装を指示（merge許可保留）
- 「PRマージ = 実装完了」と見なしてはならない

### 7. 冪等性保証（B13ガードレール）
- `processed_events` で処理済みイベントを記録し二重処理を防止

### 8. E2E不具合分類
- REQUIREMENT / REGRESSION / PRE-EXISTING / FLAKY-INFRA の4種別
- PRE-EXISTING/FLAKYは連続失敗カウントに加算しない

### 9. Batch Planning Agentへの委任
- リーダーはIssue詳細を直接読まない（コンテキスト汚染防止）
- `team_recruit(codex_scout)` + `team_assign_task` で委任し、`.vibe-team/tmp/batch-plan.json` 経由で受取
- 詳細: references/batch-planner-instructions.md

### 10. バッチ完了定義
- 本番E2E確認PASSをもってバッチ完了
- mainマージ → デプロイ監視 → 本番E2E → 完了報告まで一気通貫

### 11. E2E報告構造化必須
- ワーカーのPhase B E2E報告はJSON構造化スキーマ必須（自由テキスト禁止）
- リーダーはE2E報告ゲート検証（8項目）をクリアしない限りimplement完了としない
- **リーダーはワーカーE2E報告受領時に「このIssueのコアオペレーション（修正/追加した機能そのもの）を直接テストしたか？」を必ず自問する**（回帰テスト+デプロイ確認だけでPASS判定していないか？）
- 実行困難なシナリオ（300秒超タイムアウト、外部サービス障害等）では**コードパス整合性検証**を代替テストとして認める（直接テスト不可の理由を明示した上で適用）
- `proxy_used` が `code_path_integrity` の場合、Phase B完了時にIssueクローズコメント末尾に「ユーザー手動GUI確認依頼」ブロックを必ず追加（GUI退行はtypecheck/build/diffレビューでは検出不可）
- リーダーE2Eリレー出力義務: ワーカーE2E報告受領・ゲート検証後にリーダー自身のstdoutにE2Eサマリ（JSON形式）を出力（Stop Hook自信ゲート発火用）

### 12. ASSERT_NEXT（自動継続アサーション）
- ASSERT_NEXT句のあるStepは完了後に即時次Stepを実行する義務がある
- 途中停止はガードレールB15違反 + アンチパターン#20違反

### 13. クアドレビュー数値ゲート（必須、Tier別分母）
- `review_lanes_completed={Tier別分母}/{Tier別分母}` かつ `critical_open=0` をPhase A完了の前提条件とする（Phase 1 hard gate）
- Tier別分母: **Tier C = 2/2**、**Tier B/A = 5/5**、tier=null時はTier B（5/5）をデフォルト
- `phase2_code_review_status`: PASS | NO_FINDINGS | SKIPPED | FAILED を記録（Phase 2 soft gate）
- Phase 2 は soft gate: FAILED/SKIPPED でもPhase A完了を許可。Normal指摘は修正推奨
- ワーカーのPhase A完了報告に `review_lanes_completed`、`critical_open`、`phase2_code_review_status` を含めること
- Phase 1 未達の場合、merge許可を保留しPhase Bに進めない

### 14. Issueクローズ完了監査（必須）
- `## E2E結果` + `## クローズ根拠` がIssueコメントに存在しないと `gh issue close` 禁止

### 15. CodeRabbitレビュー確認（Phase A完了後必須）
- soft gate。ただしセキュリティ/バグ指摘は hard block

### 16. Tier判定統合（vibe-fortress-review / vibe-fortress-implement連携）
- `fortress-review-required` ラベル → 実装前に `/vibe-fortress-review --auto-gate` 自動実行
- `fortress-implement-required` ラベル → `/vibe-fortress-implement --auto` でSlice & Prove方式
- 両ラベル併存時はfortress-implementに一元化（二重実行防止）

### 17. Phase B専用ワーカー原則（教訓 #1743/#1744）
- Phase A完了後、**同一ワーカーをPhase Bに再利用しない**
- リーダーが `team_recruit(e2e_tester)` でPhase B用の新規ワーカーを採用
- 理由: Phase Aでコンテキストが飽和したワーカーはPhase B指示を正しく処理できず、idle通知を連発する事例が発生（コンテキスト汚染/飽和回避）
- `.vibe-team/tmp/issue-{N}-phase-a-summary.md` により、新ワーカーでも即座にPhase Bを開始可能

### 18. 外部LLM research lane は補助用途限定
- 外部LLM API（OpenRouter等）は planning / review / risk synthesis の補助レーンに限定
- merge/E2E/Issue closeなどの実行系には使わない
- `team_recruit(external_llm_synthesizer)` + `team_assign_task` で委任
- 外部LLMレーン失敗はバッチ停止理由にならない

### 19. Phase B条件付きASSERT_NEXT自動継続
- merge許可(`team_send`)受信後、Step 11~17を単一の条件付きASSERT_NEXT連鎖として自動実行
- 段階的エスカレーション: Step 12(局所)は自動リトライ1回許可、Step 13以降(共有リソース)は即`team_send`で報告・停止

### 20. Phase B GUI検証時の起動経路明示義務
- GUI必須アプリ（Tauri / Electron 等）のPhase B検証で、ワーカーがIssueクローズコメントに**起動経路を明示**する義務がある
- 必須記載文: 「動作確認は **`npm run dev`** または リポジトリ内 **`target/release/<app>.exe`** で起動してください。**AppData等のインストール版・Start Menu / Desktopショートカットからの起動は使用禁止**」
- 理由: ユーザー環境でauto-updater不調等によりインストール版バイナリが古いままだと、最新ビルドが正常動作していても誤判定が発生する
- リーダーはPhase Bクローズコメント送信前に上記文の存在をチェック（簡易grep可）。なければワーカーに追記指示

### 21. リーダーのrevert判断プロトコル
- 再現確認最優先 → 起動経路を疑う → 1PRずつincrementalに → 複数PR一括revertはユーザー承認必須

---

## ガードレール概要（30項目）

**継承8項目**: クアドレビュー必須、Lint/型/ビルド全パス、E2E必須、等
**バッチ固有24項目**: B1(mergeゲート)、B2(post-rebase品質)、B3(ラベル状態機械)、
B4(連続失敗制限)、B5(セーフポイント)、B6(APIレート防御)、B7(途中mainマージ禁止)、
B8(リーダー専念)、B9(並列制限)、B10(統合回帰テスト)、B11(復元ガード)、
B12(error_patterns上限)、B13(冪等性)、B14(E2E報告ゲート検証)、B15(ASSERT_NEXT停止禁止)、
**B16(自信ゲート)**: ワーカーPhase B E2E報告前に5問の自信ゲート全回答必須（C1:直接操作、C2:ユーザー視点、C3:全項目消化、C4:実動作確認、C5:修正前→後検証）、
**B17(変更箇所カバレッジ)**: 全IssueのE2E報告にchange_coverage_map必須（feat種別はCodex評価追加）、
**B18(ブラウザ外操作制約)**: ブラウザ外操作のE2Eテストで `browser_boundary` 必須、
B19(CodeRabbit確認ゲート)、
B20(E2Eリレー出力)、B21(fortress-review必須ゲート)、B22(過剰品質ゲート禁止)、
B23(GUI起動経路明示義務)、B24(revert前の現状再現確認)

---

## アンチパターン概要（39項目）

主要なもの:
- 複数Issueの同時staging merge禁止
- implementingラベルなしの実装開始禁止
- リーダーの直接実装介入禁止（`team_assign_task` で委任）
- PRマージ=実装完了と見なすことの禁止
- Issueコメント未読での実装開始禁止
- #20: ASSERT_NEXT句で停止してユーザー報告のみ行う
- #31: ワーカーE2E結果を受領してもリーダーstdoutにリレー出力しない
- #34: ワーカーがmerge許可前にstaging mergeする
- #37: GUI必須アプリのPhase Bクローズコメントで起動経路を明示しない
- #39: 再現確認なしに複数PRを連続revertする

---

## オンデマンドRead指示

| Step | Read対象 | タイミング |
|------|---------|-----------|
| 1 (resume) | references/pipeline-state-schema.md | resumeモード時 |
| 2 | references/batch-planner-instructions.md | Batch Planning Agent委任時 |
| 7開始 | references/leader-pipeline-loop.md | パイプライン開始時（必須） |
| 7a/7d | vibe-shared-roles/references/role-instructions/implementer.md | ワーカー採用時 |
| 7c-post | vibe-shared-roles/references/role-instructions/e2e_tester.md | Phase Bワーカー採用時 |

---

## クイックスタート

1. `planned` ラベル付きIssueを準備（vibe-issue-plannerで作成 or 手動）
2. `/vibe-autopilot-batch all-planned` でバッチ起動
3. ゲートキーパー: planned 0件なら即終了
4. `team_recruit(codex_scout)` で Batch Planning Agent が分析 → batch-plan.json 生成
5. ユーザーが実行計画を確認
6. `team_recruit(state_keeper)` + パイプライン実行ループ（自動）
7. 全Issue完了 → 統合回帰テスト → staging→main PR作成
8. ユーザーがRelease PR承認
9. mainマージ → 本番デプロイ監視 → 本番E2E確認 → `team_dismiss` で全メンバー解散

## 4スキル間 I/O 契約表

| 連携 | 出力元 | 出力内容 | 入力先 | 入力方法 |
|---|---|---|---|---|
| VIP→VAB | vibe-issue-planner | planned ラベル + issue-planner-meta (tier, tier_score) | vibe-autopilot-batch | gh issue list + コメント解析 |
| VAB→VFR | vibe-autopilot-batch | fortress-review-required ラベル | vibe-fortress-review | --auto-gate で起動 |
| VAB→VFI | vibe-autopilot-batch | fortress-implement-required ラベル | vibe-fortress-implement | --auto で起動 |
| VFR→VAB | vibe-fortress-review | Go/No-Go 判定 | vibe-autopilot-batch | team_send で結果返送 |
| VFI→VAB | vibe-fortress-implement | 実装完了 + 証跡パック | vibe-autopilot-batch | Phase B へ合流 |

## 関連スキル

| スキル | 関連 |
|--------|------|
| `issue-autopilot-batch` | 翻訳元（Agent Teams版） |
| `vibe-team` | MCPツール仕様の参照元 |
| `vibe-shared-roles` | 共通ロール定義（team_recruit時に参照） |
| `vibe-issue-planner` | 上流: 実装計画の作成（planned ラベル + コメント） |
| `vibe-fortress-review` | Tier A IssueのPhase A実装前レビュー |
| `vibe-fortress-implement` | Tier A(実装複雑度I2+)の多重防御実装 |
| `judgment-policy` | 判断迷い時の自律判断基準 |
| `e2e-test` | E2Eテスト計画・実行 |
| `vercel-watch` | デプロイ完了検知 |

## 外部スキル依存（オプショナル）

以下のスキルがインストール済みの場合は自動的に参照されます。未インストールでも動作します。
- judgment-policy: ユーザー判断基準（未設定時は都度ユーザーに確認）
- design-review-checklist: 設計レビューチェック（未設定時はスキップ）
- issue-naming: Issue命名規則（未設定時はデフォルト命名）

## 改訂履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-05-02 | 初版作成（issue-autopilot-batch を vibe-team MCP に翻訳） |
