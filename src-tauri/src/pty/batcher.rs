// PTY 出力バッチャ (旧 lib/pty-data-batcher.ts 等価)
//
// 16ms or 32KB で flush し、ターミナル出力を tauri::Emitter で送る。
// 大量出力時に renderer 側のレンダリングを 60fps 以下に保つため必須。

use bytes::BytesMut;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::interval;

const FLUSH_INTERVAL_MS: u64 = 16;
const FLUSH_BYTES: usize = 32 * 1024;
/// 起動直後の emit 抑止時間。
///
/// renderer 側の `listen('terminal:data:{id}', ...)` は非同期登録で、
/// `terminal_create` が返った直後〜数十 ms の間は未登録のため、
/// その間に `emit` した分は Tauri によって drop される (= 画面が真っ白のまま残る)。
/// そこで最初の flush は少し遅らせ、その間 PTY 出力は mpsc に蓄積する
/// (UnboundedReceiver なので backpressure なし)。
const STARTUP_DELAY_MS: u64 = 250;

/// PTY reader が送ってくる生バイト → 集約 → emit。
/// `data_event_name` には "terminal:data:{id}" 形式を渡す。
///
/// Issue #53: 旧実装は UnboundedReceiver で backpressure が無く、renderer が遅れると
/// メモリが無制限に膨らんだ。呼び出し側が bounded channel を使うように移行済み。
pub fn spawn_batcher(
    app: AppHandle,
    data_event_name: String,
    mut rx: mpsc::Receiver<Vec<u8>>,
) {
    tokio::spawn(async move {
        // listener 登録完了までのグレースタイム。詳細は STARTUP_DELAY_MS コメント参照。
        tokio::time::sleep(Duration::from_millis(STARTUP_DELAY_MS)).await;

        let mut buf = BytesMut::with_capacity(FLUSH_BYTES * 2);
        let mut tick = interval(Duration::from_millis(FLUSH_INTERVAL_MS));
        loop {
            tokio::select! {
                maybe = rx.recv() => {
                    match maybe {
                        Some(chunk) => {
                            buf.extend_from_slice(&chunk);
                            if buf.len() >= FLUSH_BYTES {
                                flush(&app, &data_event_name, &mut buf);
                            }
                        }
                        None => {
                            // reader thread が exit。最後にまとめて flush (final=true で lossy)。
                            flush_impl(&app, &data_event_name, &mut buf, true);
                            break;
                        }
                    }
                }
                _ = tick.tick() => {
                    if !buf.is_empty() {
                        flush(&app, &data_event_name, &mut buf);
                    }
                }
            }
        }
    });
}

/// Issue #48: flush 境界で UTF-8 マルチバイト文字を分断しないよう、
/// 末尾の未完了バイト列はバッファに残す。最終 flush (`final_flush=true`) のみ lossy で吐き出す。
fn flush(app: &AppHandle, event: &str, buf: &mut BytesMut) {
    flush_impl(app, event, buf, false);
}

fn flush_impl(app: &AppHandle, event: &str, buf: &mut BytesMut, final_flush: bool) {
    if buf.is_empty() {
        return;
    }
    let slice = &buf[..];
    // 末尾 1..=3 バイトが UTF-8 continuation / lead byte のどこまで有効かを判定する。
    let cut = if final_flush {
        slice.len()
    } else {
        valid_utf8_prefix_len(slice)
    };
    if cut == 0 {
        // 全部が continuation バイト。通常は起きないが、safety のため 1 byte だけ進める。
        if final_flush {
            let text = String::from_utf8_lossy(slice).into_owned();
            let _ = app.emit(event, text);
            buf.clear();
        }
        return;
    }
    let (emit_part, rest): (Vec<u8>, Vec<u8>) = (slice[..cut].to_vec(), slice[cut..].to_vec());
    let text = match std::str::from_utf8(&emit_part) {
        Ok(s) => s.to_string(),
        // 途中の不正バイトは既に壊れているので lossy。
        Err(_) => String::from_utf8_lossy(&emit_part).into_owned(),
    };
    match app.emit(event, text) {
        Ok(_) => tracing::debug!("[batcher] emit {event} {}B ok", emit_part.len()),
        Err(e) => tracing::warn!("emit {event} failed: {e}"),
    }
    buf.clear();
    buf.extend_from_slice(&rest);
}

/// Issue #48: slice の先頭から見て、完全な UTF-8 シーケンスだけの長さを返す。
/// 末尾に途中バイトが残っていたら、その直前までを返す (最大 3 バイト遡る)。
fn valid_utf8_prefix_len(slice: &[u8]) -> usize {
    let n = slice.len();
    if n == 0 {
        return 0;
    }
    // 末尾から最大 3 バイト遡り、最初の「先頭バイト (0xxxxxxx or 11xxxxxx)」を探す。
    let start = n.saturating_sub(4);
    for i in (start..n).rev() {
        let b = slice[i];
        let is_lead = b < 0x80 || (b & 0xC0) == 0xC0;
        if is_lead {
            // このバイトを含めた場合に必要な連続バイト数を計算
            let need = if b < 0x80 {
                1
            } else if (b & 0xE0) == 0xC0 {
                2
            } else if (b & 0xF0) == 0xE0 {
                3
            } else {
                4
            };
            return if i + need <= n { n } else { i };
        }
    }
    // すべて continuation バイト → 先頭は valid でないので 0。
    0
}
