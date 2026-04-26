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
/// Issue #186 (Security): PTY に流す文字列に ESC / 他 C0 制御文字が含まれると、
/// 受信端末で OSC 52 (クリップボード書換) / OSC 2 (タイトル偽装) / CSI 2J (画面消去) /
/// その他 cursor 誘導など、任意の端末乗っ取り経路が成立する。bracketed paste で囲んでも
/// 内側の ESC は端末によっては解釈されてしまう (PT mode の実装差異)。
///
/// 防御方針: payload 中の以下の制御文字を「U+FFFD `?`」相当に置換して中和する。
/// - \x1b (ESC)
/// - \x07 (BEL): OSC 終端としても使われる
/// - \x00 (NUL): pty バッファの不正切断要因
/// - \x08 (BS) / \x7f (DEL): 受信側 readline の手前消し悪用防止
/// - \x9b (CSI 単一バイト): 一部端末で ESC[ 相当に解釈される
/// 改行 (`\n`) と TAB (`\t`) は paste の意味的内容なので維持する。
fn sanitize_for_paste(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let code = ch as u32;
        let dangerous = matches!(ch, '\x1b' | '\x07' | '\x00' | '\x08' | '\x7f')
            || code == 0x9b
            || (code < 0x20 && ch != '\n' && ch != '\t' && ch != '\r');
        if dangerous {
            out.push('?'); // 視覚的に「ここに非表示制御があった」が分かる代替
        } else {
            out.push(ch);
        }
    }
    out
}

/// 出力フォーマット (1 つ目のチャンク先頭から):
///     <ESC>[200~ <banner><body> <ESC>[201~
///
/// 改行はそのまま保持 (paste 扱い)。MAX_PAYLOAD 超過時は body 末尾を切って ` …(truncated)`。
/// Issue #186: banner / body 両方を sanitize_for_paste で中和してから組み立てる。
pub fn build_chunks(banner: &str, body: &str) -> Vec<Vec<u8>> {
    let banner_clean = sanitize_for_paste(banner);
    let body_clean = sanitize_for_paste(body);

    let truncated: String = if body_clean.len() > MAX_PAYLOAD {
        let mut s: String = body_clean.chars().take(MAX_PAYLOAD).collect();
        s.push_str(" …(truncated)");
        s
    } else {
        body_clean
    };

    let mut payload: Vec<u8> = Vec::with_capacity(
        BP_START.len() + banner_clean.len() + truncated.len() + BP_END.len(),
    );
    payload.extend_from_slice(BP_START);
    payload.extend_from_slice(banner_clean.as_bytes());
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
        // Issue #151: 「同じ agent_id でも別 PTY に置き換わっている」場合に、後半チャンクが
        // 新 session に書き込まれて文章が「旧 + 新」混合になる事故を防ぐ。
        // 最初に取った Arc<SessionHandle> と毎回比較し、別物なら inject を中断する。
        match registry.get_by_agent(agent_id) {
            Some(current) => {
                if !Arc::ptr_eq(&current, &session) {
                    tracing::warn!(
                        "[inject] aborting: session for agent {agent_id} was replaced mid-inject"
                    );
                    return false;
                }
            }
            None => return false,
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
