//! Issue #1062: codex app-server 配送のエラー型。
//!
//! `team_hub/error.rs` と同様に thiserror 非依存・手組み (Issue #79 の anti-dep 方針)。
//! `code()` は machine-dispatch 用の安定文字列を返す (team:inject_failed の reason_code 等)。

/// app-server JSON-RPC 配送で起き得る失敗。
#[derive(Debug)]
pub enum AppServerError {
    /// unix socket への接続自体が失敗 (デーモン未起動 / パス不正)。
    Connect(std::io::Error),
    /// WebSocket upgrade ハンドシェイク失敗 (101 が返らない等)。
    Handshake(String),
    /// 送受信中の I/O エラー。
    Io(std::io::Error),
    /// フレーム / JSON が不正、または未知の opcode。
    Protocol(String),
    /// 相手が JSON-RPC error レスポンスを返した。
    Rpc { code: i64, message: String },
    /// 応答待ち / turn 受理待ちのタイムアウト。
    Timeout,
    /// ハンドシェイク後に相手が接続を閉じた。
    Closed,
}

impl AppServerError {
    /// renderer / ログへ渡す安定 reason code。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Connect(_) => "app_server_unreachable",
            Self::Handshake(_) => "app_server_handshake_failed",
            Self::Io(_) => "app_server_io",
            Self::Protocol(_) => "app_server_protocol",
            Self::Rpc { .. } => "app_server_rpc_error",
            Self::Timeout => "app_server_timeout",
            Self::Closed => "app_server_closed",
        }
    }
}

impl std::fmt::Display for AppServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(e) => write!(f, "failed to connect to app-server socket: {e}"),
            Self::Handshake(s) => write!(f, "app-server websocket handshake failed: {s}"),
            Self::Io(e) => write!(f, "app-server i/o error: {e}"),
            Self::Protocol(s) => write!(f, "app-server protocol error: {s}"),
            Self::Rpc { code, message } => {
                write!(f, "app-server rpc error (code={code}): {message}")
            }
            Self::Timeout => write!(f, "app-server request timed out"),
            Self::Closed => write!(f, "app-server connection closed unexpectedly"),
        }
    }
}

impl std::error::Error for AppServerError {}
