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
///
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

    // Issue #193: 旧実装は判定が body_clean.len() (バイト) なのに切詰が chars().take(MAX_PAYLOAD)
    // (文字数) で、UTF-8 マルチバイトでは MAX_PAYLOAD バイト超過判定後に最大 4 倍長を残してしまい、
    // 32 KiB 上限が事実上機能していなかった。
    // 修正: バイト単位で UTF-8 境界を保ったまま切る。char_indices で 1 文字ずつ加算長を計算し、
    // MAX_PAYLOAD バイトに収まる最後の境界を end として slice する。
    let truncated: String = if body_clean.len() > MAX_PAYLOAD {
        let mut end = 0usize;
        for (i, ch) in body_clean.char_indices() {
            let next = i + ch.len_utf8();
            if next > MAX_PAYLOAD {
                break;
            }
            end = next;
        }
        format!("{} …(truncated)", &body_clean[..end])
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
    let Some(session) = registry.get_by_agent(agent_id) else {
        tracing::warn!(
            "[inject] no session for agent {agent_id} — registry has no by_agent entry"
        );
        return false;
    };
    let banner = format!("[Team ← {from_role}] ");
    let chunks = build_chunks(&banner, text);
    if chunks.is_empty() {
        tracing::warn!(
            "[inject] empty chunks for agent {agent_id} (text len={})",
            text.len()
        );
        return false;
    }
    tracing::debug!(
        "[inject] -> agent {agent_id} role={from_role} chunks={} bytes={}",
        chunks.len(),
        text.len()
    );

    // 最初のチャンクは即時、以降は 15ms 間隔
    // Issue #145: session.write は std::sync::Mutex + blocking I/O なので tokio worker を
    // 直接塞ぐ。spawn_blocking でブロッキングプールに逃がし、async runtime を解放する。
    let mut iter = chunks.into_iter();
    if let Some(first) = iter.next() {
        let s = session.clone();
        match tokio::task::spawn_blocking(move || s.write(&first)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!("[inject] write(first) failed for agent {agent_id}: {e}");
                return false;
            }
            Err(e) => {
                tracing::warn!("[inject] spawn_blocking(first) failed for agent {agent_id}: {e}");
                return false;
            }
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
            None => {
                tracing::warn!(
                    "[inject] aborting: session for agent {agent_id} disappeared mid-inject"
                );
                return false;
            }
        }
        let s = session.clone();
        match tokio::task::spawn_blocking(move || s.write(&chunk)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!("[inject] write(chunk) failed for agent {agent_id}: {e}");
                return false;
            }
            Err(e) => {
                tracing::warn!("[inject] spawn_blocking(chunk) failed for agent {agent_id}: {e}");
                return false;
            }
        }
    }
    sleep(Duration::from_millis(CHUNK_DELAY_MS)).await;
    let s = session.clone();
    // Issue #378: 最終 Enter (`\r`) の書き込み結果を必ず検証する。
    // 旧実装は結果を捨てており、本文 paste は成功しても Enter 送信だけ失敗したケースを
    // delivered と扱ってしまっていた。Leader から見ると「届いたつもり」だが worker は
    // bracketed paste の入力欄表示のままで confirm されず、再送指示でようやく実行される。
    match tokio::task::spawn_blocking(move || s.write(b"\r")).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::warn!("[inject] write(\\r) failed for agent {agent_id}: {e}");
            return false;
        }
        Err(e) => {
            tracing::warn!("[inject] spawn_blocking(\\r) failed for agent {agent_id}: {e}");
            return false;
        }
    }
    tracing::debug!("[inject] -> agent {agent_id} delivered");
    true
}

#[cfg(test)]
mod build_chunks_tests {
    use super::{build_chunks, BP_END, BP_START, MAX_PAYLOAD};

    fn join(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut v = Vec::new();
        for c in chunks {
            v.extend_from_slice(c);
        }
        v
    }

    #[test]
    fn short_message_is_wrapped_in_bracketed_paste() {
        let chunks = build_chunks("[Team] ", "hello");
        let bytes = join(&chunks);
        assert!(bytes.starts_with(BP_START));
        assert!(bytes.ends_with(BP_END));
        assert!(bytes.windows(5).any(|w| w == b"hello"));
    }

    #[test]
    fn ascii_oversize_is_truncated_to_byte_limit() {
        let body = "a".repeat(MAX_PAYLOAD + 100);
        let chunks = build_chunks("", &body);
        let bytes = join(&chunks);
        let inner = &bytes[BP_START.len()..bytes.len() - BP_END.len()];
        let inner_str = std::str::from_utf8(inner).unwrap();
        let marker = " …(truncated)";
        assert!(inner_str.ends_with(marker));
        // 本文部分 (marker を除いた前半) が MAX_PAYLOAD バイトを超えないこと。
        // marker 文字列は 'a' を 1 つ含む (trunc[a]ted) ので char count では合算されてしまう。
        // バイト長で本文のサイズを直接検証する。
        let body_only_bytes = inner.len() - marker.len();
        assert!(
            body_only_bytes <= MAX_PAYLOAD,
            "body_only_bytes {body_only_bytes} exceeded MAX_PAYLOAD {MAX_PAYLOAD}"
        );
        assert!(
            body_only_bytes >= MAX_PAYLOAD - 1,
            "kept too few bytes: {body_only_bytes}"
        );
    }

    /// Issue #193 回帰テスト: マルチバイト UTF-8 でも MAX_PAYLOAD バイトに収まること。
    /// 旧実装は chars().take(MAX_PAYLOAD) で「文字数」で切っていたため、3 byte 文字なら
    /// 最大 ~3 倍長を残していた。
    #[test]
    fn multibyte_oversize_stays_within_byte_limit() {
        // 「あ」は UTF-8 で 3 bytes。MAX_PAYLOAD バイト換算で約 32768/3 = 10922 文字までしか入らない。
        // 旧実装はここで chars().take(MAX_PAYLOAD)=32768 文字 ~= 98 KiB を残してしまう。
        let body = "あ".repeat(MAX_PAYLOAD); // 約 98 KiB
        let chunks = build_chunks("", &body);
        let bytes = join(&chunks);
        let inner = &bytes[BP_START.len()..bytes.len() - BP_END.len()];
        // truncated 末尾分は許容する (固定 14 byte 程度) が、本文部分は MAX_PAYLOAD 以下
        let truncated_marker = " …(truncated)";
        assert!(inner.windows(truncated_marker.len()).any(|w| w == truncated_marker.as_bytes()));
        let body_only_len = inner.len() - truncated_marker.len();
        assert!(
            body_only_len <= MAX_PAYLOAD,
            "body bytes {body_only_len} exceeded MAX_PAYLOAD {MAX_PAYLOAD}"
        );
        // UTF-8 として valid であること (境界で切れていないこと)
        assert!(std::str::from_utf8(&inner[..body_only_len]).is_ok());
    }
}
