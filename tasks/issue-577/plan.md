## 実装計画

### ゴール
`cancel_pending_recruit` を **2 段階化** し、ack timeout 直後 (~ 2000 ms) に renderer から ack が遅着しても、renderer のカードを残したまま「救済」できるようにする。`team_recruit` 呼び出し側には timeout エラーを返す既存挙動は維持。`team:recruit-rescued` イベントを新設して、HR / Leader 側で「タイムアウトしたが救済された」ことを観測できるようにする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/state.rs`
  - `pending_recruits` の値型を `PendingRecruit` から `PendingRecruitState` 列挙 (`Active(PendingRecruit) / TimedOut { pending: PendingRecruit, deadline: Instant }`) に拡張、または `PendingRecruit` 自体に `timed_out_at: Option<Instant>` フィールドを追加 (後者の方が差分が小さい — 採用)。
  - `cancel_pending_recruit` を 2 段階化: 段階 A (即時) で ack_tx を close + `team:recruit-cancelled` emit、段階 B (grace 後) で pending entry を remove する background task を `tokio::spawn` で起動。grace は env `VIBE_TEAM_RECRUIT_GRACE_MS` で 0〜10000 ms、デフォルト 2000 ms。
  - `resolve_recruit_ack` を拡張: `pending.timed_out_at` が Some だった場合、ack_tx は既に None (drop 済み) なので送信せず、代わりに `team:recruit-rescued` イベントを emit + `[teamhub] recruit_ack rescued agent=... late_by_ms=...` を tracing::info 出力。
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — 既存 timeout 分岐は変更なし (cancel_pending_recruit 呼び出しはそのまま、内部 2 段階化で吸収)。
- `src-tauri/src/team_hub/protocol/tools/create_leader.rs` — 同上 (内部実装の変更だけで吸収)。
- `src/renderer/src/lib/use-recruit-listener.ts` — `team:recruit-rescued` リスナを新規追加。既に配置済みのカードはそのまま維持し、必要なら toast や activity feed に「採用 (遅延救済)」表示を出す。
- `src/types/shared.ts` — `RecruitRescuedPayload { newAgentId: string; lateByMs: number }` 型を追加 (Rust 側 `serde(rename_all = "camelCase")` と整合)。
- (テスト) `src-tauri/src/team_hub/state.rs` の `#[cfg(test)] mod tests` または `state_tests.rs` — grace 中 ack / grace 後 ack / cancel と ack のレース。

### 実装ステップ
- [ ] Step 1: `PendingRecruit` に `timed_out_at: Option<std::time::Instant>` を追加 (差分最小化)。
- [ ] Step 2: `cancel_pending_recruit` を改修。即時で `ack_tx.take().drop()` + emit `team:recruit-cancelled` + `pending.timed_out_at = Some(Instant::now())` をセット。grace 後に entry を remove する task を `tokio::spawn` で起動 (grace 期間は env 変数読み)。
- [ ] Step 3: `resolve_recruit_ack` を改修。`pending.timed_out_at.is_some()` の分岐を追加し、rescue パスでは `team:recruit-rescued` を emit + info ログ。`ack_done` の compare_exchange は維持 (重複防止)。
- [ ] Step 4: `src/types/shared.ts` に `RecruitRescuedPayload` 追加。`tauri-ipc-commands` skill の 5 点同期チェック (この変更はイベント payload なので、Rust struct と TS 型の 2 点同期が中心)。
- [ ] Step 5: `use-recruit-listener.ts` に `team:recruit-rescued` リスナ追加。カードは維持、Toast Context で「採用 (遅延救済)」を 1 回だけ通知。
- [ ] Step 6: 単体テスト追加 — (a) timeout 後 grace 中の ack で rescue ログが出る、(b) grace 経過後の ack は従来通り `no_pending_recruit` で破棄、(c) cancel と ack が同時に走った場合 `ack_done` の compare_exchange で正しく直列化される。
- [ ] Step 7: env 変数の挙動を `tasks/issue-577/notes.md` または既存の env 一覧 (`VIBE_TEAM_RECRUIT_ACK_TIMEOUT_SECS` と並べて) に記載。

### 検証方法
- `cargo test -p vibe-editor team_hub::state` (新規テストが通る)
- `npm run typecheck` (shared.ts の型追加が TS 側でエラーにならない)
- `npm run build` で Tauri ビルドが通る
- 手動回帰: `VIBE_TEAM_RECRUIT_ACK_TIMEOUT_SECS=1` (timeout を意図的に短く) + `VIBE_TEAM_RECRUIT_GRACE_MS=2000` で recruit を 6 体並列実行。タイムアウトしたが grace 中に ack が届いた agent はカードが残ること、tracing ログに `recruit_ack rescued` が出ることを確認。
- `VIBE_TEAM_RECRUIT_GRACE_MS=0` で grace 無効化が効くことを確認 (既存挙動と一致)。

### リスク・代替案
- リスク 1: grace 中の `pending` entry が残ると memory が膨らむ。→ background task で確実に remove、tokio::time::sleep の cancel safety に留意 (tokio::spawn のハンドルが TeamHub のライフタイムを超えても安全)。
- リスク 2: rescue 時にカードを残すが、agent 側の handshake が結局来ないケース → renderer 側で「rescue 後 N 秒以内に handshake が無ければカードを灰色化」する UX 改善は本 issue のスコープ外 (別 issue 化候補)。
- リスク 3: `compare_exchange` のレース。`ack_done` は AtomicBool なので safe。`timed_out_at` は `Mutex<TeamHubState>` 配下なので排他制御済み。
- 代替案: `PendingRecruitState` 列挙で型レベルに状態を持たせる方法 → 差分が大きい。本 issue は最小差分で `Option<Instant>` 追加にとどめ、必要なら Phase 3 で型強化。

### 想定 PR 構成
- branch: `feat/issue-577-recruit-rescue`
- commit 粒度: 1 commit (state.rs + use-recruit-listener.ts + shared.ts + tests)。テスト分が大きければ別 commit に。
- PR title 案: `feat(teamhub): #577 タイムアウト後 grace 期間中の recruit ack を救済`
- 本文に `Closes #577` を含める。`Refs #574, #576` (親 / 関連 follow-up) も併記。
- 依存関係: #576 とは独立 (state.rs の差分がコンフリクトする可能性は中。先行 merge した方が rebase は楽)。
