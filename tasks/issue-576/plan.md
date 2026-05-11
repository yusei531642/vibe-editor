## 実装計画

### ゴール
team_hub 側に **team 単位の semaphore** を入れて「同時に renderer に投げる recruit 件数」を上限制御する。HR が 6 体一気に採用しても renderer の event queue / React rerender が詰まらず、`recruit_ack_timeout` が 0 件で着地する状態にする。Issue 本文の修正案 1 (semaphore) を採用、permit 数は 2 を初期値にして tunable にする。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/state.rs` — `TeamHub` (または内部 `TeamHubState`) に `recruit_semaphores: Mutex<HashMap<String /* team_id */, Arc<tokio::sync::Semaphore>>>` を追加。`acquire_recruit_permit(team_id) -> SemaphorePermit` ヘルパを生やす。permit 数は `VIBE_TEAM_RECRUIT_CONCURRENCY` 環境変数で 1〜8 の範囲を tunable に (デフォルト 2)。
- `src-tauri/src/team_hub/protocol/tools/recruit.rs` — `team_recruit` 本体の冒頭 (`check_permission` 直後) で permit を取得し、permit 保持のまま emit → ack 受領 (or timeout) → `cancel_pending_recruit` までを 1 クリティカルセクションに包む。permit drop は `team_recruit` の return / panic / cancel いずれでも自動で起きる (`SemaphorePermit` の Drop)。
- `src-tauri/src/team_hub/protocol/tools/create_leader.rs` — 同様に permit 取得を入れる (こちらも recruit 経路と同じ ack 待機構造)。
- `src-tauri/src/team_hub/protocol/consts.rs` (該当時) — `RECRUIT_DEFAULT_CONCURRENCY: usize = 2` 等を追加。
- (テスト) `src-tauri/src/team_hub/state.rs` 末尾の `#[cfg(test)] mod tests` か新規 `recruit_semaphore_tests.rs` — semaphore の取得 / 解放 / drop on cancel / drop on panic を `tokio::test` で確認。

### 実装ステップ
- [ ] Step 1: `state.rs` に `recruit_semaphores` フィールド + `acquire_recruit_permit(team_id)` を追加。permit 数は env 変数読み込み + デフォルト 2。team_id ごとに lazy init。
- [ ] Step 2: `team_recruit` の冒頭で permit 取得 → 関数末尾まで保持。タイムアウト分岐 / エラー分岐でも permit が drop されるよう `let _permit = ...;` で束ねる。
- [ ] Step 3: `team_create_leader` でも同じ permit 取得を入れる (Leader 作成は HR 採用と同じく ack 待ちがあるため対象)。
- [ ] Step 4: 単体テスト追加 — (a) permit=1 で 2 並列 recruit が直列化される、(b) panic / cancel で permit が解放される、(c) 異なる team_id は独立に並列実行できる、を `tokio::test` で確認。
- [ ] Step 5: `VIBE_TEAM_RECRUIT_CONCURRENCY` を README/docs (該当時) または `tasks/issue-576/notes.md` に記載。

### 検証方法
- `cargo test -p vibe-editor team_hub` (team_hub サブモジュールのテストが通る)
- `npm run typecheck` (Rust 変更のみだが念のため)
- `npm run build` で Tauri ビルドが通る
- 手動回帰: HR 役で `team_recruit` を 6 体並列に投げる E2E。Phase 1 の `[teamhub] recruit_ack received elapsed_ms=...` ログを観察し、p95 < 5000 ms / 失敗 0 件を確認。Canvas タブ非アクティブ条件でも同様。
- 既存 `VIBE_TEAM_DISABLE_RECRUIT_ACK=1` フォールバックが共存することを確認 (このパスでは permit 取得自体は走るが ack 待機は no-op になる)

### リスク・代替案
- リスク 1: permit を `team_recruit` 全体に被せると `find_requester` の 200ms grace 等も直列化されて、permit=1 時の合計時間が線形に伸びる。→ デフォルト permit=2 で半並列にして緩和。permit 数は env で実測値ベースに調整。
- リスク 2: `team_id` が cross-team で漏れた場合、無関係の team まで待たされる。→ semaphore は team_id 単位で独立 (異なる team_id は別 Semaphore) なので影響しない。
- リスク 3: permit 取得待ち中に caller (MCP client) が timeout する可能性。→ `acquire_owned` ではなく `try_acquire_owned` + 既存 `RECRUIT_TIMEOUT` (30s) と同水準のタイムアウトを permit 取得側にも入れる (Step 2 で実装)。
- 代替案: 修正案 2 (mutex / permit=1) → permit=1 ケースとして本実装に内包される。修正案 3 (動的 permit 調整) は Phase 3 (本 issue では実装しない、ログ収集後に別 issue 化)。

### 想定 PR 構成
- branch: `feat/issue-576-recruit-semaphore`
- commit 粒度: 1 commit (state.rs + recruit.rs + create_leader.rs + tests を 1 まとめ)。テスト追加分が大きければ tests のみ別 commit に分けても可。
- PR title 案: `feat(teamhub): #576 同時 recruit を team 単位 semaphore で順番待ち化`
- 本文に `Closes #576` を含める。`Refs #574` (親 issue) も併記。
