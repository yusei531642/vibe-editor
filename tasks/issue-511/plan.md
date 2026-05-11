## 実装計画

### ゴール
PTY bracketed-paste 注入 (`inject.rs`) が、session 差し替え / 末尾 Enter 失敗 / TUI 側の bracketed-paste 非対応で silent fail することを fail-loud 化し、未確定の inject を呼び出し元と Leader が把握できる状態にする。既存の `Arc::ptr_eq` abort と末尾 `\r` 防御は維持し、その上にエラー伝播・リトライ・代替経路を載せる。

### 影響範囲 / 触るファイル
- `src-tauri/src/team_hub/inject.rs` — 注入結果に詳細エラー (session_replaced / final_cr_failed / write_partial / bracketed_paste_unsupported) を返す
- `src-tauri/src/team_hub/error.rs` — `InjectError` 細分化、`SendError` に伝播
- `src-tauri/src/team_hub/protocol/tools/send.rs` — partial failure を `delivery_status` に反映 (失敗 agent_id を別配列で返す)
- `src/renderer/src/components/canvas/AgentNodeCard/CardFrame.tsx` — inject 失敗時のリトライボタンと警告 toast
- `src-tauri/src/team_hub/protocol/consts.rs` — chunk size / interval / max_retry の定数化
- (任意) `src-tauri/src/pty/` 側で bracketed-paste 対応有無を一度 probe する仕組み (TUI 起動直後に DA1 / DA2 応答を見る等) — 重いので別 issue 化推奨

### 実装ステップ
- [ ] Step 1: inject.rs の write 結果を詳細化 (どこまで書けたか、最後の `\r` 結果を含む)
- [ ] Step 2: error 型を細分化し、send.rs まで伝播
- [ ] Step 3: 1 回限りの自動リトライ (session が同じ場合のみ、max_retry=1, backoff=200ms)
- [ ] Step 4: UI に注入失敗 toast + リトライ手段
- [ ] Step 5: ユニットテスト (mock writer で write 部分失敗を再現)
- [ ] テスト: 既存 inject テスト + 新規 partial-write テスト

### 検証方法
- `cargo test -p vibe_editor team_hub::inject`
- `cargo test -p vibe_editor team_hub::protocol::tools::send`
- 手動: 注入直後に PTY を kill、または agent_id 同じで session を差し替えるシナリオを作って fail-loud になるか確認

### リスク・代替案
- リスク: 自動リトライが二重実行を起こす (TUI 側で paste が一部受理済み)。bracketed paste の境界で abort した場合のみリトライ可とする。
- 代替案: bracketed paste fallback (1 行ずつ送る) — TUI 互換性が広がるが UX が遅い。今回は detect + warn のみ。

### 想定 PR 構成
- branch: `fix/issue-511-pty-inject-fail-loud`
- commit 粒度: 1 commit
- PR title: `fix(vibe-team): PTY 注入失敗を fail-loud 化し partial-failure を delivery_status に伝播`
- 本文に `Closes #511`、関連 #509 / #512 を記載
