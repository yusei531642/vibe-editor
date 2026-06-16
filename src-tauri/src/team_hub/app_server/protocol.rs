//! Issue #1062: codex app-server JSON-RPC のメソッド名定数。
//!
//! ワイヤ仕様は JSON-RPC 2.0 互換だが `"jsonrpc":"2.0"` ヘッダは省略される。
//! 本モジュールでは PR1 で使うメソッドのみ定義する (未使用定数は dead_code になるため増やさない)。

/// クライアント能力をネゴシエートする初回リクエスト。
pub(crate) const INITIALIZE: &str = "initialize";

/// `initialize` 応答後にクライアントが送る通知。
pub(crate) const INITIALIZED: &str = "initialized";

/// 既存スレッドを resume して以降の `turn/start` を紐付ける (best-effort)。
pub(crate) const THREAD_RESUME: &str = "thread/resume";

/// スレッドに新しいユーザー入力を追加してターン開始。
pub(crate) const TURN_START: &str = "turn/start";

/// 実行中ターンに割り込み入力 (bracketed-paste 割り込みの公式版)。
pub(crate) const TURN_STEER: &str = "turn/steer";
