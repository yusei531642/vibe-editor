//! Issue #1062: `team_send` の配送経路ルータ。
//!
//! 既定は従来どおり PTY への bracketed-paste 注入 (`inject::inject`)。
//! codex セッションで `app_server_socket` と `thread_id` の両方が分かっている場合のみ、
//! codex 公式 app-server JSON-RPC (`turn/start`) で配送する。app-server 配送が失敗したら
//! PTY 注入にフォールバックするため、可用性は従来以上を保つ。
//!
//! 第1段では `SessionHandle` の上記 2 フィールドを populate する経路が未実装のため、
//! 実行時には常に PTY 経路を通る (= 機能は休眠)。app-server 経路の有効化は後続フェーズ。

use std::sync::Arc;

use crate::pty::SessionRegistry;
use crate::team_hub::inject::{self, InjectError};

/// `agent_id` 宛にメッセージを配送する。戻り値・リトライ意味論は `inject::inject` と同一。
pub async fn deliver_message(
    registry: Arc<SessionRegistry>,
    agent_id: &str,
    from_role: &str,
    text: &str,
) -> Result<(), InjectError> {
    if let Some(session) = registry.get_by_agent(agent_id) {
        if session.is_codex {
            if let (Some(socket), Some(thread_id)) = (
                session.app_server_socket.as_deref(),
                session.thread_id.as_deref(),
            ) {
                match crate::team_hub::app_server::deliver(
                    socket, thread_id, text, /* in_flight */ false,
                )
                .await
                {
                    Ok(()) => return Ok(()),
                    Err(err) => {
                        tracing::warn!(
                            "[deliver] app-server delivery failed for agent {agent_id} \
                             (code={}); falling back to PTY inject",
                            err.code()
                        );
                        // フォールスルーして PTY 注入を試みる。
                    }
                }
            }
        }
    }
    inject::inject(registry, agent_id, from_role, text).await
}
