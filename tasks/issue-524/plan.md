## 実装計画

### ゴール
`team_update_task` / `team_status` の自己申告だけに依存している現状に対し、PTY 出力アクティビティ・command 完了などの物理シグナルを TeamHub diagnostics 側で計測し、自己申告と乖離したら Leader / ユーザーにアラートする。N 分以上 status 更新がない場合は `stale` 扱いにして自動マークする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/protocol/tools/diagnostics.rs` — `staleness` (last_status_age, last_pty_activity_age) と auto_stale フラグを返す
- `src-tauri/src/pty/` — PTY からの出力イベントが発生した時刻を `lastPtyOutputAt` として TeamHub state に通知 (現状は無いと予想されるので新規連携)
- `src-tauri/src/team_hub/mod.rs` — `MemberDiagnostics` に `last_pty_output_at: Option<Instant>` を追加
- `src-tauri/src/team_hub/protocol/consts.rs` — STATUS_STALE_THRESHOLD_SECS (例: 300)
- `src/types/shared.ts` — diagnostics レスポンス型に追加
- `src/renderer/src/components/canvas/AgentNodeCard/CardFrame.tsx` — staleness バッジ表示
- `.claude/skills/vibe-team/SKILL.md` — worker 行動規約に「主要 shell コマンド前後で `team_status` を必ず更新する」を追記
- `src/renderer/src/lib/role-profiles-builtin.ts` — WORKER_TEMPLATE に同上を追加

### 実装ステップ
- [ ] Step 1: pty → team_hub への `last_pty_output_at` 通知 (callback or channel)
- [ ] Step 2: diagnostics で staleness 計算と返却
- [ ] Step 3: shared.ts と UI への反映 (Issue #510 と統合可能)
- [ ] Step 4: WORKER_TEMPLATE / skill にステータス更新ルールを追加
- [ ] テスト: staleness 判定のユニットテスト

### 検証方法
- `cargo test`
- 手動: worker を起動して 5 分放置 → diagnostics で stale フラグが立ち、Canvas 上にバッジが出ることを確認

### リスク・代替案
- リスク: PTY 出力イベントを team_hub に流すと、ターミナルログが大量だと負荷増。timestamp の更新だけにする (内容は持たない)。
- 代替案: bridge.js から keepalive を活用 (既に 90s なので staleness の代替指標として使える)。ただし「実作業中か」までは判定できないため PTY 出力 timestamp を併用するのが望ましい。

### 想定 PR 構成
- branch: `fix/issue-524-task-status-staleness`
- commit 粒度: 1 commit
- PR title: `fix(vibe-team): タスク自己申告の staleness を物理シグナルで補正し stale 検出を可視化`
- 本文に `Closes #524`、関連 #510 を記載
