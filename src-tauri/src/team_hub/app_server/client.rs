//! Issue #1062: codex app-server への JSON-RPC クライアント (unix socket 直結)。
//!
//! PR1 は「1 配送 = 1 接続」の単発フロー (connect → initialize → turn 送信)。
//! 長寿命プーリング / 通知購読は後続フェーズで HubState に持たせる。

use serde_json::{json, Value};
use tokio::net::UnixStream;

use super::error::AppServerError;
use super::protocol;
use super::wire::WsStream;

/// app-server への 1 本の接続。`next_id` で JSON-RPC の id 相関を行う。
pub struct AppServerConn {
    ws: WsStream<UnixStream>,
    next_id: i64,
}

impl AppServerConn {
    /// unix socket に接続し WebSocket ハンドシェイクまで完了する。
    pub async fn connect(socket_path: &str) -> Result<Self, AppServerError> {
        let stream = UnixStream::connect(socket_path)
            .await
            .map_err(AppServerError::Connect)?;
        let mut ws = WsStream::new(stream, /* mask_outgoing */ true);
        ws.client_handshake().await?;
        Ok(Self { ws, next_id: 1 })
    }

    /// `initialize` → `initialized` のハンドシェイク。
    pub async fn initialize(&mut self) -> Result<(), AppServerError> {
        let params = json!({
            "clientInfo": { "name": "vibe-editor", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": {}
        });
        self.request(protocol::INITIALIZE, params).await?;
        self.notify(protocol::INITIALIZED, json!({})).await?;
        Ok(())
    }

    /// 指定スレッドへメッセージを 1 件配送する。
    /// `in_flight` が真なら実行中ターンへの `turn/steer`、偽なら新規 `turn/start`。
    /// 戻り値 Ok は「ターンが受理された (= 配送成功)」を意味し、ターン完了までは待たない。
    pub async fn deliver_turn(
        &mut self,
        thread_id: &str,
        text: &str,
        in_flight: bool,
    ) -> Result<(), AppServerError> {
        // best-effort resume: 新規 in-memory スレッドでは "no rollout" エラーになり得るが、
        // threadId さえ有効なら turn/start は成立するため、resume の失敗は無視する。
        let _ = self
            .request(protocol::THREAD_RESUME, json!({ "threadId": thread_id }))
            .await;

        let method = if in_flight {
            protocol::TURN_STEER
        } else {
            protocol::TURN_START
        };
        let params = json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": text }],
        });
        self.request(method, params).await?;
        Ok(())
    }

    /// リクエストを送り、対応する id のレスポンスが返るまで読む。
    /// 途中の通知は捨て、server→client リクエストには空 result で ack して相手を詰まらせない。
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, AppServerError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({ "id": id, "method": method, "params": params }))
            .await?;

        loop {
            let Some(line) = self.ws.read_text().await? else {
                return Err(AppServerError::Closed);
            };
            let v: Value = serde_json::from_str(&line)
                .map_err(|e| AppServerError::Protocol(format!("invalid json: {e}")))?;

            let msg_id = v.get("id").and_then(Value::as_i64);
            let has_method = v.get("method").is_some();

            // 自分のリクエストへのレスポンス。
            if msg_id == Some(id) && !has_method {
                if let Some(err) = v.get("error") {
                    let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
                    let message = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    return Err(AppServerError::Rpc { code, message });
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }

            // server→client リクエスト (approval 等) は空 ack で流す。
            if let (Some(req_id), true) = (msg_id, has_method) {
                self.write_message(&json!({ "id": req_id, "result": {} }))
                    .await?;
            }
            // それ以外 (通知) は無視して次を読む。
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), AppServerError> {
        self.write_message(&json!({ "method": method, "params": params }))
            .await
    }

    async fn write_message(&mut self, msg: &Value) -> Result<(), AppServerError> {
        let text = serde_json::to_string(msg)
            .map_err(|e| AppServerError::Protocol(format!("serialize failed: {e}")))?;
        self.ws.write_text(text.as_bytes()).await
    }
}
