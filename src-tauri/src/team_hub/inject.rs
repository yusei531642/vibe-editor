// PTY への bracketed-paste 注入
//
// 旧実装は改行を空白化 + 4KB トランケート + 64B/15ms チャンクで送る方式だったが、
// 21 件 issue 起票のような長文 / 多行コンテンツでは末尾が truncated される問題があった。
// (旧コメントには「Claude Code はブラケットペースト送信不可」とあったが、現行の
//  Claude Code は普通にペーストを受け取り `[Pasted text #N +M lines]` として 1 件扱いに
//  バンドルしてくれる。ユーザー画面で実証済み。)
//
// 改修方針:
//  - 全体を `ESC [ 200 ~ ... ESC [ 201 ~` で囲んだ bracketed paste 形式で送る。
//    Claude Code (および bracketed-paste 対応 TUI) は中身を「1 件のペースト」として扱う。
//  - 改行は保持。空白化しない (paste 扱いなので生 \n がそのまま入る)。
//  - 上限を 32 KiB に拡張 (旧 4 KiB)。Hub 側 SOFT_PAYLOAD_LIMIT (32 KiB) と整合。
//  - ConPTY バッファ事故を避けるためチャンク化 (64 B / 15 ms) は維持。
//  - 全チャンク後に `\r` を送って送信確定。
//  - banner `[Team ← <role>] ` も paste 領域内に含めて 1 ブロック化する。

use crate::pty::SessionRegistry;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const CHUNK_SIZE: usize = 64;
const CHUNK_DELAY_MS: u64 = 15;
/// bracketed paste 化に伴い上限を引き上げ。Hub の SOFT_PAYLOAD_LIMIT と揃える。
const MAX_PAYLOAD: usize = 32 * 1024;

/// bracketed paste の開始マーカー (CSI 200 ~)
const BP_START: &[u8] = b"\x1b[200~";
/// bracketed paste の終了マーカー (CSI 201 ~)
const BP_END: &[u8] = b"\x1b[201~";

/// 1 メッセージを bracketed paste 形式に包んで ConPTY-safe な 64B チャンク列にする。
///
/// 出力フォーマット (1 つ目のチャンク先頭から):
///     <ESC>[200~ <banner><body> <ESC>[201~
///
/// 改行はそのまま保持 (paste 扱い)。MAX_PAYLOAD 超過時は body 末尾を切って ` …(truncated)`。
pub fn build_chunks(banner: &str, body: &str) -> Vec<Vec<u8>> {
    let truncated: String = if body.len() > MAX_PAYLOAD {
        let mut s: String = body.chars().take(MAX_PAYLOAD).collect();
        s.push_str(" …(truncated)");
        s
    } else {
        body.to_string()
    };

    let mut payload: Vec<u8> =
        Vec::with_capacity(BP_START.len() + banner.len() + truncated.len() + BP_END.len());
    payload.extend_from_slice(BP_START);
    payload.extend_from_slice(banner.as_bytes());
    payload.extend_from_slice(truncated.as_bytes());
    payload.extend_from_slice(BP_END);

    let mut chunks = Vec::new();
    let mut i = 0;
    while i < payload.len() {
        let mut end = (i + CHUNK_SIZE).min(payload.len());
        // UTF-8 継続バイト (0b10xxxxxx) の途中で切らないよう後退
        while end < payload.len() && (payload[end] & 0xc0) == 0x80 {
            end -= 1;
        }
        chunks.push(payload[i..end].to_vec());
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
    // Issue #145: session.write は std::sync::Mutex + blocking I/O なので tokio worker を
    // 直接塞ぐ。spawn_blocking でブロッキングプールに逃がし、async runtime を解放する。
    let mut iter = chunks.into_iter();
    if let Some(first) = iter.next() {
        let s = session.clone();
        if tokio::task::spawn_blocking(move || s.write(&first))
            .await
            .ok()
            .and_then(|r| r.ok())
            .is_none()
        {
            return false;
        }
    }
    for chunk in iter {
        sleep(Duration::from_millis(CHUNK_DELAY_MS)).await;
        // セッションがまだ生きているか確認
        if registry.get_by_agent(agent_id).is_none() {
            return false;
        }
        let s = session.clone();
        if tokio::task::spawn_blocking(move || s.write(&chunk))
            .await
            .ok()
            .and_then(|r| r.ok())
            .is_none()
        {
            return false;
        }
    }
    sleep(Duration::from_millis(CHUNK_DELAY_MS)).await;
    let s = session.clone();
    let _ = tokio::task::spawn_blocking(move || s.write(b"\r")).await;
    true
}
