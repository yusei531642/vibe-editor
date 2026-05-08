# Issue #576 — 同時メンバー採用時のレンダラー負荷を team 単位 semaphore で順番待ち化

## 環境変数

### `VIBE_TEAM_RECRUIT_CONCURRENCY`

- 役割: 1 チームあたり同時に renderer に投げる recruit / create_leader 件数の上限
  (= `team_recruit` / `team_create_leader` を team_id ごとの `tokio::sync::Semaphore` で
  permit 制御するときの permit 数)。
- 既定値: `2` (= `RECRUIT_DEFAULT_CONCURRENCY`)
- 有効範囲: `1..=8` (= `RECRUIT_MAX_CONCURRENCY`)
- 範囲外 / parse 失敗 / 未設定はいずれも既定値にフォールバック (= `2`)
- 評価タイミング: `team_id` 単位で初回 acquire 時に確定し、その後の env 変更では
  再評価しない。アプリ起動時にのみ調整する想定。

permit 取得待ち時間が長引いて caller (MCP client) が timeout するのを避けるため、
permit 取得側にも既存 `RECRUIT_TIMEOUT` (30s) と同水準のタイムアウトを設定済み。
取得失敗時は `recruit_permit_timeout` / `create_leader_permit_timeout` の構造化エラーで返る。

## 実装メモ

- `recruit_semaphores: HashMap<String, Arc<Semaphore>>` を `HubState` に追加し、
  `team_id` ごとに lazy 初期化する。
- `acquire_recruit_permit(team_id)` が `OwnedSemaphorePermit` を返す。`team_recruit` /
  `team_create_leader` の冒頭で `let _permit = ...;` で関数末尾まで束ね、Drop で自動解放。
- 異なる `team_id` は別々の Semaphore を持つので cross-team の recruit は影響しない。
- 単体テスト (`recruit_semaphore_tests`) で以下を確認:
  - permit=1 で 2 並列 acquire が直列化される
  - 保持中 task が panic / cancel しても Drop で permit が解放される
  - 異なる team_id は独立に並列実行できる

## 関連

- 親 Issue: #574 (Phase 1: timeout 拡張 / 観測強化)
- スコープ外 (将来の別 issue):
  - 遅着 ack の救済 (Phase 2 follow-up #2)
  - Canvas タブ非アクティブ時の UI 警告 (Phase 2 follow-up #3)
  - Windows PTY spawn 計測 (Phase 2 follow-up #4)
