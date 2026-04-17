# ADR-3: TeamHub Rust 化 (tokio TCP + 64B/15ms inject)

**Status**: Accepted
**Date**: 2026-04-17
**Phase**: 0
**PoC**: `experiments/team-hub-rust/`

## Context
既存 `src/main/team-hub.ts` は Node.js の `net.Server` + JSON-RPC (line-delimited JSON) で動作。Tauri 移行で Rust 化が必要。
**重要**: `injectIntoPty` の **64B チャンク + 15ms 間隔注入**は ConPTY バッファ上限の対策として実証済み — 必ず保持。

## Decision
- **tokio::net::TcpListener** で 127.0.0.1:7373 listen (現実装と同 protocol)
- 1 接続 = 1 `tokio::spawn` で `BufReader::lines()` ベースの line protocol
- `serde` で JSON 直接デシリアライズ (`#[serde(tag = "op", rename_all = "snake_case")]`)
- 64B/15ms inject は `data.chunks(64)` + `tokio::time::sleep(15ms)` で再現

## PoC 実証
- ✅ `cargo build` 12.61 秒で成功
- ✅ TCP listener 起動: `INFO TeamHub PoC listening on 127.0.0.1:7373`
- ✅ PowerShell から register / send / list 動作確認:
  ```
  [register reply] {"ok":true,"msg":"registered"}
  [send reply]     {"ok":true,"msg":"sent"}
  [list reply]     ["prog-1"]
  ```
- ✅ サーバ stdout に `[inject:prog-1] hello from leader 1234567890ABCDEFGHIJ` (64B/15ms チャンク経由)
- ⚠️ 短メッセージ (40B) では単一チャンクで完了 — 256B 以上の長メッセージで複数チャンク動作を Phase 1 で確認

## Phase 1 への引き継ぎ
- `src-tauri/src/team_hub/mod.rs`: 本 PoC の TCP listener コードをそのまま移植
- `src-tauri/src/team_hub/inject.rs`: `MemberSink::write` の中身を **portable_pty `MasterPty.take_writer()`** に差し替え (mock の println! を実 PTY write に)
- `src-tauri/src/team_hub/handoff_event.rs`: send 時に `app_handle.emit("team:handoff", { from, to, preview })` を追加 (Phase 3 のエッジアニメ用)
- 既存 `team-bridge.js` (CLI 内 MCP↔TCP bridge) は **無改修で繋がる**

## 却下案
- **std::net + 自前スレッドプール**: tokio エコシステム (serde, tracing) の旨味を捨てる
- **gRPC**: 過剰、現運用は line JSON で十分
- **WebSocket**: テキストプロトコルの利点はあるが、CLI 側 (team-bridge.js) との互換性破壊
