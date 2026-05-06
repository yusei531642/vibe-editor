# Issue #470 - Leader orchestration state persistence

## 計画

- [x] Issue #470 の本文、計画コメント、ラベル状態を確認する。
- [x] `vibeeditor` / `pullrequest` / `issue-autopilot-batch` / `root-cause-guardrail` / `fortress-review` の該当手順を確認する。
- [x] Root Cause Confirmed まで、handoff / TeamHub / team-history / Canvas restore の現行実装を読む。
- [x] `team-state` 永続化ストアを追加し、TeamHub の `activeLeaderAgentId` / tasks / worker reports / human gate を保存する。
- [x] `team_assign_task` / `team_update_task` / `team_send` / leader switch 系 tool を team-state と handoff lifecycle に接続する。
- [x] `TeamHistoryMember.agentId` と orchestration summary を追加し、Canvas / IDE restore で永続 agentId を優先する。
- [x] Canvas の履歴表示で human gate / handoff status が見えるようにする。
- [x] Rust / TypeScript の単体テストを追加し、型・ビルド検証を実行する。

## RCA結果

- RCA Mode: Root Cause Confirmed
- 症状: Leader handoff や再起動後に、同じ teamId の監督状態、pending worker reports、next actions を復元できない。
- 再現: Issue #470 の再現手順と証拠コマンドにより、`team-history.json` の `sessionId: null`、handoff JSON の `status: created` 固着、TeamHub delivery 継続を確認済み。
- 原因箇所:
  - `src-tauri/src/team_hub/mod.rs`: `TeamInfo.messages` / `tasks` / `active_leader_agent_id` が in-memory only。
  - `src-tauri/src/commands/team_history.rs`: `TeamHistoryEntry` が roster / canvas / latest handoff までで orchestration state を持たない。
  - `src/renderer/src/layouts/CanvasLayout.tsx`: restore 時に `${role}-${i}-${teamId}` で agentId を再生成する。
  - `src/renderer/src/components/canvas/cards/AgentNodeCard.tsx`: handoff 作成後の injected / acked / retired lifecycle が durable に更新されない。
- 独立証拠: Issue #470 の `team-history.json` / handoff JSON / `vibe-editor.log` 観測と、現行コード上の in-memory only 実装が一致している。
- 除外した代替原因: TeamHub socket / bridge の単純断線ではなく、`team_send` / `inject delivered` がログ上継続しているため、復元不能の主因は durable orchestration state 不在。
- 修正方針: TeamHub mutation を team-state 永続化に接続し、restore 時は persisted agentId / active leader / task snapshot を再利用する最小変更にする。
- 判定: A=YES, B=YES, C=YES, D=YES

## Fortress Review

- Tier: A (Issue コメントの tier_score=22 / fortress-review-required)
- 実行方式: ユーザーが sub-agent 利用を明示していないため、メインエージェントで 5 観点を順次確認する。
- 観点:
  - 影響範囲: Rust TeamHub / commands / shared types / Canvas restore を横断するため高。
  - テスト網羅: Rust unit と TS unit を追加し、最低 `npm run typecheck` と `cargo check` を通す。
  - 要件整合: Issue 受け入れ条件の durable transition / pending tasks / human gate 表示を直接対象にする。
  - 障害シナリオ: app restart / handoff status alias / missing old team-state / regenerated agentId を後方互換で扱う。
  - データ整合: `~/.vibe-editor/team-state/<project>/<teamId>.json` は schemaVersion と atomic_write を使う。

## Next Steps

- [x] `team-state` helper と型を追加する。
- [x] TeamHub の mutation ごとに persisted snapshot を更新する。
- [x] Canvas / IDE restore の agentId 再生成を後方互換 fallback に変える。
- [x] handoff lifecycle tool (`team_ack_handoff`) と status alias (`started -> injected`, `acknowledged -> acked`) を追加する。
- [x] テストと品質ゲートを実行し、進捗・検証結果・残課題をこのファイルへ追記する。

## 進捗

- [x] `src-tauri/src/commands/team_state.rs` を追加し、`~/.vibe-editor/team-state/<project>/<teamId>.json` に orchestration snapshot を保存・読込できるようにした。
- [x] TeamHub の team 登録、active leader 切替、task assign/update、worker report、human gate、handoff lifecycle を永続化へ接続した。
- [x] `team_ack_handoff` tool と handoff status alias を追加し、created -> injected -> acked -> retired の遷移を保存できるようにした。
- [x] team-history に `agentId` と orchestration summary を追加し、Canvas / IDE restore で保存済み agentId を優先するようにした。
- [x] Canvas / session 履歴に human gate と handoff status summary を表示した。

## 検証結果

- [x] `cargo check --manifest-path src-tauri\Cargo.toml`: PASS
- [x] `npm run typecheck`: PASS
- [x] `npx vitest run src\renderer\src\lib\__tests__\canvas-layout-helpers.test.ts`: PASS (5 tests)
- [x] `cargo test --manifest-path src-tauri\Cargo.toml update_task_records_structured_report_and_human_gate -- --nocapture`: PASS
- [x] `cargo test --manifest-path src-tauri\Cargo.toml pending_tasks_exclude_done_tasks -- --nocapture`: PASS
- [x] `npm run test`: PASS (30 files / 199 tests)
- [x] `npm run build:vite`: PASS
- [x] `git diff --check`: PASS

## Next Tasks

- [ ] PR を作成する場合は本文に `Closes #470` と上記検証結果を記載する。
- [ ] CodeRabbit / CI / 人間レビューを待ち、自動マージは行わない。
- [ ] 必要に応じて Tauri 実機起動で handoff 復元の手動 smoke を追加確認する。
