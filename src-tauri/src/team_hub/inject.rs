// PTY への 64B / 15ms チャンク注入
//
// 旧 team-hub.ts の injectIntoPty を Rust 移植。
// ConPTY バッファ上限の対策として実証済みの数値:
// - 1 チャンク 64 byte
// - チャンク間 15ms
// - UTF-8 マルチバイト境界で切らない (継続バイト 0x80..=0xBF が先頭ならチャンク末尾を後退)
// - banner `[Team ← <role>] ` を先頭に付与
// - 4KB を超えるメッセージは ` …(truncated)` でトランケート
// - 改行は ` ` または ` | ` に整形 (Claude Code はブラケットペースト送信不可)
// - 全チャンク後に \r を送信して送信完了

use crate::pty::SessionRegistry;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const CHUNK_SIZE: usize = 64;
const CHUNK_DELAY_MS: u64 = 15;
const MAX_PAYLOAD: usize = 4096;

/// 1 メッセージを ConPTY-safe な形に整形してチャンク列に分割
pub fn build_chunks(banner: &str, body: &str) -> Vec<Vec<u8>> {
    // 改行整形
    let flat: String = body
        .chars()
        .scan(false, |prev_nl, c| {
            if c == '\n' {
                let out = if *prev_nl { Some(' ') } else { Some(' ') };
                *prev_nl = true;
                out
            } else {
                *prev_nl = false;
                Some(c)
            }
        })
        .collect();
    // 連続改行 (2 つ以上) は最初の Map で全て空白化済み — シンプルにそのまま使う
    let truncated = if flat.len() > MAX_PAYLOAD {
        let mut s: String = flat.chars().take(MAX_PAYLOAD).collect();
        s.push_str(" …(truncated)");
        s
    } else {
        flat
    };

    let mut payload = String::with_capacity(banner.len() + truncated.len());
    payload.push_str(banner);
    payload.push_str(&truncated);

    let bytes = payload.into_bytes();
    let mut chunks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let mut end = (i + CHUNK_SIZE).min(bytes.len());
        // UTF-8 継続バイト (0b10xxxxxx) の途中で切らないよう後退
        while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
            end -= 1;
        }
        chunks.push(bytes[i..end].to_vec());
        i = end;
    }
    chunks
}

/// 指定 agent_id の PTY に整形済みメッセージを 64B/15ms で書き込み、最後に \r を送る
pub async fn inject(
    registry: Arc<SessionRegistry>,
    agent_id: &str,
    from_role: &str,
    text: &str,
) -> bool {
    let session = match registry.get_by_agent(agent_id) {
        Some(s) => s,
        None => return false,
    };
    let banner = format!("[Team ← {from_role}] ");
    let chunks = build_chunks(&banner, text);
    if chunks.is_empty() {
        return false;
    }

    // 最初のチャンクは即時、以降は 15ms 間隔
    let mut iter = chunks.into_iter();
    if let Some(first) = iter.next() {
        if session.write(&first).is_err() {
            return false;
        }
    }
    for chunk in iter {
        sleep(Duration::from_millis(CHUNK_DELAY_MS)).await;
        // セッションがまだ生きているか確認
        if registry.get_by_agent(agent_id).is_none() {
            return false;
        }
        if session.write(&chunk).is_err() {
            return false;
        }
    }
    sleep(Duration::from_millis(CHUNK_DELAY_MS)).await;
    let _ = session.write(b"\r");
    true
}
