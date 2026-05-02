---
name: vibe-issue-planner
description: |
  vibe-teamで全オープンIssueを並列分析し、Codex調査を経て実装計画をIssueコメントに自動投稿する。
  vibe-editor Canvas版。issue-planner の vibe-team MCP 翻訳。
  トリガー: "vibe-issue-planner", "vibeで計画", "canvasで計画"
---

# vibe-issue-planner スキル

## 概要

GitHub Issues URLまたはリポジトリ名を渡すだけで、**vibe-team MCP** でチームを動的に編成し、
全オープンIssueを**並列分析**。**Codex CLI（read-only）** による原因調査を経て、
詳細な実装計画をIssueコメントに自動投稿する。

issue-planner の vibe-team 版。Agent Teams の Task/TeamCreate を
`team_recruit` / `team_assign_task` / `team_send` / `team_dismiss` に置き換えた構成。

```
URL入力 → ゲートキーパー → team_recruit(issue_scanner) → issue-scan.json →
plan_writer×N 採用 → 各ワーカー内部(Codex Scout → 外部LLM → Codex Main → レビュー → 投稿) →
team_dismiss(全員)
```

## トリガー条件

- `/vibe-issue-planner [GitHub Issues URL | owner/repo]`
- 「vibeで計画」「canvasで計画」「vibe-issue-planner」等のキーワード

### 入力形式

- **GitHub Issues URL**: `https://github.com/owner/repo/issues`
- **リポジトリ名**: `owner/repo`

### オプション

| オプション | 既定値 | 意味 |
|-----------|--------|------|
| `--external-llm auto\|on\|off` | `auto` | `auto` は条件一致時のみ起動、`on` は常時、`off` は無効 |
| `--external-llm-timeout-ms <ms>` | `600000` | 外部LLM補助分析のタイムアウト（既定10分） |

## 差異マッピングテーブル（Agent Teams → vibe-team MCP）

| issue-planner (Agent Teams) | vibe-issue-planner (vibe-team) |
|---|---|
| Issue Scanner Agent (`Task tool`) | `team_recruit(issue_scanner)` + `team_assign_task` |
| Codex Scout (`Bash codex exec`) | `team_recruit(codex_scout)` + `team_assign_task` |
| Codex Main Analysis (`stdin経由`) | `team_recruit(codex_analyzer)` + `team_assign_task` |
| 多角レビュー (`Task tool ×N`) | `team_recruit(reviewer_*)` ×Tier別 + `team_assign_task` |
| 外部LLM補助分析 | `team_recruit(external_llm_synthesizer)` + `team_assign_task` |
| TeamCreate | `team_recruit`（ロール定義＋採用を1コールで） |
| TeamDelete | `team_dismiss(agent_id)` |
| TaskCreate / TaskGet | `team_assign_task` / `team_get_tasks` |
| Team内メッセージ | `team_send(to, message)` |
| 監視・ポーリング | `team_read({unread_only: true})` |

## チーム編成計画

### 固定メンバー
- **Leader**: オーケストレーション、全体進行管理（engine: claude）
- **issue_scanner** ×1: Issue一覧スキャン・JSON出力（engine: claude）

### 動的メンバー（Issue数・Tierに応じて増減）
- **plan_writer** ×1-3: 各Issueの計画作成（engine: claude）
  - 0件: 処理終了、1-5件: 1名、6-12件: 2名、13+件: 3名
- **reviewer_tech** ×1: 技術正確性レビュー（Tier C以上で採用）
- **reviewer_archi** ×1: アーキテクチャ適合性（Tier B以上で採用）
- **reviewer_devils** ×1: Devil's Advocate（Tier C以上で採用）
- **reviewer_security** ×1: セキュリティレビュー（Tier Aのみ採用）

### 条件付きメンバー
- **external_llm_synthesizer** ×0-1: 外部LLM補助分析（条件合致時のみ、engine: claude）
- **codex_final_checker** ×0-1: 投稿前最終検証（engine: codex）

### 採用ルール
- 3名以上の一括採用 → HR経由で委譲
- 7±2ルール: 最大でも Leader 直轄8体なので直轄OK

## リーダーワークフロー（9ステップ）

| Step | 内容 | vibe-team操作 |
|------|------|-------------|
| 1 | 入力解析（owner/repo抽出） | — |
| 1.5 | ゲートキーパー（`gh issue list` で0件チェック → 即終了） | — |
| 2 | Issue Scanner 起動 | `team_recruit` → `team_assign_task` |
| 3 | issue-scan.json 読取 + バリデーション | `team_read` で結果受信 → ファイル Read |
| 4 | フィルタリング結果報告（**確認なしで自動遷移**） | — |
| 5 | ワーカー数決定（1-3名、3名以上→HR経由） | — |
| 6 | plan_writer 採用 → Issue割当 | `team_recruit` ×N → `team_assign_task` ×N |
| 7 | 全ワーカー完了監視 | `team_read({unread_only: true})` |
| 8 | risk_scorer でTier判定 → ラベル付与 | `team_recruit(risk_scorer)` → `team_assign_task` → Tier判定結果受信 → `gh issue edit --add-label` |
| 9 | 完了サマリ → 全メンバー解雇 | `team_dismiss` ×全員 |

詳細: references/leader-workflow.md

## 核心ルール（18項目）

### 1. Issue Scanner への委任
- リーダーはIssue一覧/コメントを直接取得しない（コンテキスト汚染防止）
- `team_recruit(issue_scanner)` → `team_assign_task` で委任
- `.vibe-team/tmp/issue-scan.json` 経由で結果受取

### 2. スキップ判定（二重投稿防止）
- `planned` ラベル付きIssue → スキップ
- コメントに `## 実装計画` / `## Implementation Plan` が存在 → スキップ + ラベル補完

### 3. 動的ワーカー数
- 0件: 処理終了、1-5件: 1ワーカー、6-12件: 2ワーカー、13+件: 3ワーカー
- Issue Scanner が `recommended_worker_count` として算出

### 4. Codex調査（vibe-team経由 + タイムアウト防止）
- `team_recruit(engine=codex)` + `team_assign_task` でCodex調査を委任する
- Codex Scout: `team_recruit(codex_scout)` → `team_assign_task`（タイムアウト: 240000ms）
- Codex Main: `team_recruit(codex_analyzer)` → `team_assign_task`（タイムアウト: 300000ms）
- 結果は `team_read` で受信し、永続化は `.vibe-team/tmp/codex_output_{number}.txt` に保存
- タイムアウト時の5段階フォールバック（部分出力回収→プロンプト短縮→reasoning引下げ→skip-git→スキップ）

### 5. 外部LLM補助分析（条件付き起動 + 10分タイムアウト）
- `--external-llm auto|on|off` で制御
- `auto` では複雑/長文/外部依存/Xポスト知見が必要な場合のみ起動
- `team_recruit(external_llm_synthesizer)` → `team_assign_task` で委任
- 外部LLMの内容は補助情報。ファイルパス・行番号は Codex とローカル確認で再検証必須

### 6. 外部LLM出力の信頼境界
- `verification_required=true` の情報は裏取りなしで最終計画に書かない
- Xポスト・コミュニティ知見は「未検証補助情報」扱い

### 7. 多角的レビュー（Tier別動的 2-4体並列）

| Tier | レビュアー構成 | completion_rate閾値 |
|------|-------------|-------------------|
| C (< 6) | reviewer_tech + reviewer_devils = 2体 | ≥ 50% (1/2) |
| B (≥ 6) | + reviewer_archi = 3体 | ≥ 67% (2/3) |
| A (≥ 12) | + reviewer_security = 4体 | ≥ 75% (3/4) |

- 全レビュアーは `team_recruit` → `team_assign_task` で並列起動
- severity統合: critical=必須修正、major=修正推奨、minor=テスト追加、suggestion=反映しない
- 投稿可: `completion_rate >= Tier別閾値` かつ `critical_open == 0`

### 8. 投稿順序の厳守
- コメント投稿 → 成功確認 → ラベル追加（逆順禁止）
- `planned` ラベル適用は必須

### 9. ワーカー間タスク分配（反対端方式）
- planner-1: ID昇順、planner-2: ID降順で取得
- `team_assign_task` の description に取得順序を明示

### 10. チームシャットダウンフロー
- 全ワーカーに `team_send` で shutdown_request → 確認後 `team_dismiss`
- 未応答なら30秒待機後に `team_dismiss`

### 11. Codex final-check（投稿前の最終検証）
- レビュー統合後、投稿前に `team_recruit(codex_final_checker)` で最終検証
- composite_grade A かつ critical_open==0 の場合のみ省略可

### 12. レビュー完了率の報告義務
- ワーカー完了報告（`team_send('leader', ...)`）に必須フィールド:
  `tier`, `tier_score`, `reviewer_count`, `review_completion_rate`,
  `critical_open`, `final_check`, `composite_grade`

### 13. 外部LLM利用状況の報告義務
- ワーカー完了報告に `external_llm_used`, `external_llm_status`, `external_llm_mode`, `external_llm_timeout_ms` 必須

### 14. ブランチ検証（コード調査前の必須チェック）
- Issue参照PRのマージ先ブランチを確認し、調査対象ブランチを決定
- staging にマージ済み → staging 基準、main にマージ済み → main 基準
- サブエージェントに「{branch}ブランチを基準に調査せよ」と明示

### 15. vibe-team 委任の制約（#1922 #1923 教訓）
- ワーカーに `gh` / `git` / `Write` / `Edit` 等のシェル・ファイル操作を直接任せない
- これらは Leader が `team_assign_task` でタスクとして渡し、結果を `team_read` で回収する
- ワーカー自身が実行してよいのは Read / Grep / Glob に閉じた純粋分析タスクのみ
- `team_send` は bracketed paste で配送。改行入り内容も ~32KiB まで直接渡せる
- 超過時のみ `.vibe-team/tmp/<short_id>.md` に書き出して「サマリ + ファイルパス」を送る

### 16. 判断に迷ったら Codex に相談（Decision Gate）
- 次アクションの候補が複数ある場合、ユーザーに委ねる前に `team_recruit(engine=codex)` で判断根拠を求める
- Codex 相談テンプレート（Decision Gate）:
  - **現状**: 今どういう状態か
  - **候補**: 取りうるアクション一覧
  - **評価軸**: 工数・リスク・波及範囲
  - **推奨案**: 根拠とともに JSON で返させる
- ユーザーへの候補選択依頼は最終手段（Codex 応答が低信頼 or コード外の文脈が必要な時のみ）

### 17. final-check fail 時の2段階投稿（例外フロー）
- デフォルト（A案）: 計画改訂 → 再 final-check → pass で投稿
- 例外（B案）: critical==0 かつ major/suggestion のみ残存、かつ**時間制約がある場合**のみ採用可
  - 元 plan を投稿 + 直後に**補足コメント**で「レビュー指摘の明細 + 反映方針 + 更新される受け入れ基準」を明記
  - メタデータは正直に記述する（`final_check: fail_v1_resolved_in_supplement` 等）
- critical 残存時は B案禁止（必ずA案で改訂）

### 18. 中間確認の禁止（一気通貫実行）
- ゲートキーパー判定後・フィルタリング結果報告後の確認質問を出力禁止
- 対象1件以上 → Step 2 へ自動遷移、Step 5（ワーカー展開）まで一気通貫
- ユーザーの明示中止（`stop`/`中止`/`cancel`）のみで停止
- **例外**: 10件以上の本番 force-push 等、真に破壊的かつ取り返しがつかない操作のみ確認を残す（issue-planner の通常フローには該当する操作なし）

## plan_writer ワーカー内部フロー

| Step | 内容 | vibe-team操作 |
|------|------|-------------|
| W-1 | Issue詳細取得（`gh issue view`） | — |
| W-2 | ブランチ検証（PR参照先→調査対象ブランチ決定） | — |
| W-3 | Codex Scout（軽量事前調査） | `team_recruit(codex_scout)` → `team_assign_task` |
| W-3.1 | 外部LLM Context Synthesis（条件付き） | `team_recruit(external_llm_synthesizer)` → `team_assign_task` |
| W-3.2 | Codex Main Analysis（stdin経由） | `team_recruit(codex_analyzer)` → `team_assign_task` |
| W-4 | 計画組立（テンプレート構造化） | — |
| W-4.5 | Tier判定 + Reviewer採用・レビュー | `team_recruit(reviewer_*)` ×Tier別 |
| W-4.7 | Final check（条件付き） | `team_recruit(codex_final_checker)` |
| W-5 | 投稿（コメント → ラベル順序厳守） | — |
| W-6 | 完了報告 → 次タスク取得 | `team_send('leader', '完了報告: ...')` |

詳細: references/plan-writer-instructions.md

## 状態管理

### 中間ファイル
- `.vibe-team/tmp/issue-scan.json`: Issue Scanner 出力
- `.vibe-team/tmp/codex_output_{number}.txt`: Codex 出力永続化
- `.vibe-team/tmp/external_llm/issue-{number}.json`: 外部LLM中間成果物

### チームシャットダウンフロー
1. Leader が全ワーカーに `team_send` で `shutdown_request` 送信
2. 各ワーカーが `shutdown_approved` を返信
3. Leader が `team_dismiss(agent_id)` で順次解雇
4. 未応答なら30秒待機後に強制 `team_dismiss`

## 外部LLM補助分析の条件（auto モード）

以下のいずれかに該当した場合のみ起動:
- 外部依存シグナルがある
- Issue本文 + コメントが500行以上
- コメントが10件以上
- `candidate_files` が8件以上
- `pre_tier_score` が6以上
- Xポストやコミュニティ知見の横断収集が必要

### 外部LLM 実行モード

| mode | 条件 | 内容 | timeout |
|------|------|------|---------|
| `repo_context_only` | 通常起動 | Issue本文・コメント・候補ファイル・関連PR整理 | 600000ms |
| `extended_knowledge` | `x_research_required=true` | 上記 + Xポスト・コミュニティ知見整理 | 600000ms |

## モデル役割分担

| モデル | 役割 | 使いどころ |
|--------|------|-----------|
| Claude (engine: claude) | オーケストレーション・文脈整理・統合判断 | Leader、Reviewer、plan_writer |
| Codex (engine: codex) | コード根拠付き精密分析 | codex_scout、codex_analyzer、codex_final_checker |
| 外部LLM（OpenRouter等） | 長文統合・広い外部知見の補助分析 | external_llm_synthesizer（OpenRouter等経由、未設定時Claude代替） |

## エラーハンドリング概要

| エラー | 対応 |
|--------|------|
| issue_scanner 失敗 | `team_dismiss` → 再 `team_recruit` → 再失敗ならリーダーフォールバック |
| 外部LLM認証エラー | `external_llm_status=skipped_auth` → Claude代替またはCodex単独へ降格 |
| 外部LLMタイムアウト | 1回再試行 → 失敗時 Claude代替またはCodex単独へ降格 |
| Codexタイムアウト/kill | 部分出力回収 → 5段階フォールバック |
| GitHubレートリミット | 全ワーカーに `team_send` で一時停止指示 → 60秒待機 |
| コメント投稿失敗 | リトライ → ローカル保存 |

## アンチパターン

- リーダーがIssue一覧を直接取得（コンテキスト汚染）
- コメント前にラベル追加
- レビュー完了率未確認で投稿
- 外部LLMのファイルパスを未検証で採用
- 対象Issueが残っている状況で中間確認を挟む（核心ルール18違反）
- `team_assign_task` せずに `team_send` でタスクを渡す（追跡不可）
- ワーカーが自分から他ワーカーにタスクを割り振る（Leader の仕事）
- Codex CLI の廃止済み引数（`--ask-for-approval never`, `-C <dir>`）を使う
- ゲートキーパー結果報告を質問形で締める（進行宣言に置き換える）

## 関連スキル

| スキル | 関連 |
|--------|------|
| `issue-planner` | 翻訳元（Agent Teams版） |
| `vibe-team` | MCPツール仕様の参照元 |
| `vibe-shared-roles` | 共通ロール定義（採用時に参照） |
| `fortress-review` | Tier判定スコアリングの参照元 |
| `fortress-implement` | Tier A Issueの実装参照 |
| `issue-naming` | Issueタイトル命名規則（起票前に必ず参照） |
| `codex` | Codex CLIコマンド形式の参照元 |
| `openrouter` | 外部LLM呼び出しパターンの参照元 |
| `judgment-policy` | 判断迷い時の自律判断基準 |

## 詳細リファレンス

| ファイル | 内容 |
|---------|------|
| references/leader-workflow.md | 9ステップの詳細手順 + vibe-team コール例 |
| references/issue-scanner-instructions.md | issue_scanner ロールの instructions テンプレート |
| references/plan-writer-instructions.md | plan_writer ロールの instructions テンプレート |

## クイックスタート

1. `/vibe-issue-planner https://github.com/owner/repo/issues` または `owner/repo`
2. ゲートキーパーが0件チェック → issue_scanner が自動スキャン
3. plan_writer×N が並列で Codex調査 → 計画組立 → レビュー → 投稿
4. 完了レポート（優先度順テーブル + 工数合計見積）
5. `team_dismiss` で全メンバー解雇

## 計画品質チェックリスト

- [ ] 全オープンIssueがスキャンされたか
- [ ] 各IssueにCodex調査結果が含まれているか
- [ ] 優先度順テーブルが出力に含まれているか
- [ ] `planned` ラベルが計画済みIssueに付与されたか
- [ ] 全Issueの `review_completion_rate >= Tier別閾値` か（C≥50%, B≥67%, A≥75%）
- [ ] 全Issueの `critical_open == 0` か
- [ ] Tier A Issueに `fortress-review-required` + `fortress-implement-required` ラベルが付与されたか
- [ ] composite_grade A以外のIssueで `final_check == pass` か
- [ ] 外部LLM起動Issueに `external_llm_status`, `external_llm_timeout_ms` が残っているか
- [ ] `verification_required=true` の外部LLM知見が未検証のまま最終計画に出ていないか
- [ ] コード調査が正しいブランチ（staging/main）を基準に実施されたか
- [ ] issue-naming 5原則のセルフチェックリストを通過したか

## 外部スキル依存（オプショナル）

以下のスキルがインストール済みの場合は自動的に参照されます。未インストールでも動作します。
- judgment-policy: ユーザー判断基準（未設定時は都度ユーザーに確認）
- design-review-checklist: 設計レビューチェック（未設定時はスキップ）
- issue-naming: Issue命名規則（未設定時はデフォルト命名）

## 改訂履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-05-02 | 初版作成（issue-planner vibe-team版への翻訳） |
| 2026-05-02 | Codex検証12件修正: Grok条件数値修正(500行/10件)、核心ルール15-18翻訳補完、Codex調査vibe-team化、risk_scorer手順追加、チェックリスト修正 |
