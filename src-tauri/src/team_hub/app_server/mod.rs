//! Issue #1062: codex 公式 app-server JSON-RPC による team_send 配送 (第1段)。
//!
//! 現状の `team_send` は PTY に bracketed-paste で生入力を注入している。codex には
//! 走行中スレッドへ送る公式 API (`turn/start` / `turn/steer`) があり、共有 app-server
//! デーモンに繋いだ別クライアントから撃つと、TUI(購読者) にライブ反映される。
//!
//! 本モジュールはその配送クライアント。PR1 では `super::deliver` から呼ばれるが、
//! `SessionHandle::app_server_socket` / `thread_id` が populate されるのは後続フェーズの
//! ため、実行時には既定で PTY 経路のまま (= 休眠基盤)。

pub mod client;
pub mod error;
mod protocol;
mod wire;

#[cfg(test)]
mod tests;

pub use client::AppServerConn;
pub use error::AppServerError;

/// 単発配送のタイムアウト (接続 + initialize + turn 受理まで)。
const DELIVER_TIMEOUT_SECS: u64 = 10;

/// 指定 socket の app-server に接続し、`thread_id` のスレッドへ `text` を 1 件配送する。
///
/// connect → initialize → (best-effort resume) → turn/start。
/// 全体を [`DELIVER_TIMEOUT_SECS`] で囲み、ハングを防ぐ。
pub async fn deliver(socket_path: &str, thread_id: &str, text: &str) -> Result<(), AppServerError> {
    let fut = async {
        let mut conn = AppServerConn::connect(socket_path).await?;
        conn.initialize().await?;
        conn.start_turn(thread_id, text).await
    };
    match tokio::time::timeout(std::time::Duration::from_secs(DELIVER_TIMEOUT_SECS), fut).await {
        Ok(result) => result,
        Err(_) => Err(AppServerError::Timeout),
    }
}

/// 実行中ターンへ割り込み入力を配送する。
///
/// `turn/steer` は active turn の照合用に `expected_turn_id` が必須。現段階の
/// `team_send` ルータは active turn id を保持しないため未使用だが、後続の通知購読
/// フェーズで安全に呼べるよう typed entry point として分けておく。
#[allow(dead_code)] // 通知購読で active turn id を保持する後続フェーズから呼び出す。
pub async fn steer(
    socket_path: &str,
    thread_id: &str,
    expected_turn_id: &str,
    text: &str,
) -> Result<(), AppServerError> {
    let fut = async {
        let mut conn = AppServerConn::connect(socket_path).await?;
        conn.initialize().await?;
        conn.steer_turn(thread_id, expected_turn_id, text).await
    };
    match tokio::time::timeout(std::time::Duration::from_secs(DELIVER_TIMEOUT_SECS), fut).await {
        Ok(result) => result,
        Err(_) => Err(AppServerError::Timeout),
    }
}
