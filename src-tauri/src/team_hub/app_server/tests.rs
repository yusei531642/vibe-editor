//! Issue #1062: app_server クライアントの round-trip テスト。
//!
//! in-process の mock app-server (WebSocket-over-unix の server 側) を temp socket に立て、
//! `deliver()` が initialize → turn/start を正しく往復し、エラー/未到達も正しく扱うか検証する。

use super::error::AppServerError;
use super::wire::WsStream;
use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};

/// mock の挙動。turn/start に対し OK を返すか RPC エラーを返すか。
#[derive(Clone, Copy)]
enum TurnBehavior {
    Ok,
    RpcError,
}

/// temp socket に mock app-server を立て、接続を 1 本さばくタスクを spawn する。
/// 返り値はクライアントが繋ぐ socket パス。
fn spawn_mock(behavior: TurnBehavior) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = std::env::temp_dir().join(format!("vibe-as-{}.sock", &id[..8]));
    let path_str = path.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).expect("bind mock socket");

    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let _ = serve_conn(stream, behavior).await;
        }
    });
    path_str
}

async fn serve_conn(stream: UnixStream, behavior: TurnBehavior) -> Result<(), AppServerError> {
    let mut ws = WsStream::new(stream, /* mask_outgoing */ false);
    ws.server_handshake().await?;
    loop {
        let Some(line) = ws.read_text().await? else {
            return Ok(());
        };
        let msg: Value =
            serde_json::from_str(&line).map_err(|e| AppServerError::Protocol(e.to_string()))?;
        let (Some(id), Some(method)) = (
            msg.get("id").and_then(Value::as_i64),
            msg.get("method").and_then(Value::as_str),
        ) else {
            // 通知 (initialized 等) は無視。
            continue;
        };
        let reply = match (method, behavior) {
            ("turn/start", TurnBehavior::RpcError) => json!({
                "id": id,
                "error": { "code": -32000, "message": "mock turn rejected" }
            }),
            ("turn/start", TurnBehavior::Ok) => json!({
                "id": id,
                "result": { "turn": { "id": "mock-turn" } }
            }),
            _ => json!({ "id": id, "result": {} }),
        };
        let text = serde_json::to_string(&reply).expect("serialize reply");
        ws.write_text(text.as_bytes()).await?;
    }
}

#[tokio::test]
async fn deliver_happy_path_round_trips() {
    let path = spawn_mock(TurnBehavior::Ok);
    let result = super::deliver(&path, "thread-123", "hello team", false).await;
    assert!(result.is_ok(), "expected Ok, got {result:?}");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn deliver_surfaces_rpc_error() {
    let path = spawn_mock(TurnBehavior::RpcError);
    let result = super::deliver(&path, "thread-123", "hello team", false).await;
    match result {
        Err(AppServerError::Rpc { code, .. }) => assert_eq!(code, -32000),
        other => panic!("expected Rpc error, got {other:?}"),
    }
    assert_eq!(result.err().map(|e| e.code()), Some("app_server_rpc_error"));
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn deliver_steer_uses_in_flight_path() {
    // in_flight=true でも mock は id+method に応答するので Ok になる。
    // (turn/steer のメソッド分岐が panic せず往復することの確認。)
    let path = spawn_mock(TurnBehavior::Ok);
    let result = super::deliver(&path, "thread-123", "steer text", true).await;
    assert!(result.is_ok(), "expected Ok, got {result:?}");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn deliver_to_missing_socket_is_unreachable() {
    let missing = std::env::temp_dir().join("vibe-as-does-not-exist.sock");
    let result = super::deliver(&missing.to_string_lossy(), "thread-123", "hello", false).await;
    assert_eq!(
        result.err().map(|e| e.code()),
        Some("app_server_unreachable")
    );
}
