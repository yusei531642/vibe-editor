// PTY 出力バッチャ (旧 lib/pty-data-batcher.ts 等価)
//
// 16ms or 32KB で flush し、ターミナル出力を tauri::Emitter で送る。
// 大量出力時に renderer 側のレンダリングを 60fps 以下に保つため必須。

use crate::pty::session::{append_scrollback, Scrollback};
use bytes::BytesMut;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::interval;

const FLUSH_INTERVAL_MS: u64 = 16;
const FLUSH_BYTES: usize = 32 * 1024;
/// 起動直後の emit 抑止時間。
///
/// 旧設計 (Issue #285 以前) は renderer が `terminal_create` の戻り値で id を受け取って
/// から `listen()` を張る post-subscribe 方式で、cold start 時に 250ms でも取り逃がす
/// ケースがあった。Issue #285 で renderer は client-generated id で pre-subscribe 後に
/// create を呼ぶ方式に変更されたため、本 delay は補助的な安全網となった。
/// pre-subscribe しない旧経路 (id を渡さない呼び出し) のフォールバック用に短い猶予を残す。
const STARTUP_DELAY_MS: u64 = 50;

/// Issue #53: bounded チャネル容量 (vec chunk 単位)。
/// PTY reader は 8KB/chunk なので、256 枠 ≒ 2MB の backpressure buffer。
/// これを超えると reader thread の blocking_send がブロックし、自動的に
/// PTY へ backpressure が伝播する (unbounded による無限メモリ膨張を防ぐ)。
pub const PTY_CHANNEL_CAPACITY: usize = 256;

/// PTY reader が送ってくる生バイト → 集約 → emit。
/// `data_event_name` には "terminal:data:{id}" 形式を渡す。
///
/// Issue #285 follow-up: `scrollback` は SessionHandle と共有されるリングバッファ。
/// emit と同期して push し、attach 経路 (HMR remount / Canvas/IDE 切替) で
/// `SessionHandle::scrollback_snapshot()` から replay されるための材料になる。
pub fn spawn_batcher(
    app: AppHandle,
    data_event_name: String,
    mut rx: mpsc::Receiver<Vec<u8>>,
    scrollback: Scrollback,
) {
    tokio::spawn(async move {
        // 旧 post-subscribe 経路互換のための短い猶予 (詳細は STARTUP_DELAY_MS コメント)。
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
                                flush(&app, &data_event_name, &mut buf, &scrollback);
                            }
                        }
                        None => {
                            // reader thread が exit。最後にまとめて flush。
                            flush(&app, &data_event_name, &mut buf, &scrollback);
                            break;
                        }
                    }
                }
                _ = tick.tick() => {
                    if !buf.is_empty() {
                        flush(&app, &data_event_name, &mut buf, &scrollback);
                    }
                }
            }
        }
    });
}

fn flush(app: &AppHandle, event: &str, buf: &mut BytesMut, scrollback: &Scrollback) {
    if buf.is_empty() {
        return;
    }
    // Issue #48: buf 末尾がマルチバイト UTF-8 文字の途中だと from_utf8_lossy が
    // U+FFFD に置換してしまう (日本語・絵文字・Box drawing が文字化けする原因)。
    // 末尾から遡って「完結している境界」を見つけ、そこまでを emit、残りは buf に戻す。
    let safe_end = safe_utf8_boundary(buf);
    if safe_end == 0 {
        // 先頭もマルチバイト途中 → 次 flush まで保留 (emit しない)
        return;
    }
    let remainder: Vec<u8> = buf[safe_end..].to_vec();
    buf.truncate(safe_end);
    let len = buf.len();
    // Issue #285 follow-up: emit する確定済みバイト列を scrollback にも反映する。
    // 容量超過分は前から drop されるので、attach 経路では「最近 64 KiB」だけ replay される。
    append_scrollback(scrollback, buf);
    let text = String::from_utf8_lossy(buf).into_owned();
    buf.clear();
    if !remainder.is_empty() {
        buf.extend_from_slice(&remainder);
    }
    match app.emit(event, text) {
        Ok(_) => tracing::debug!("[batcher] emit {event} {len}B ok"),
        Err(e) => tracing::warn!("emit {event} failed: {e}"),
    }
}

/// Issue #48: buf のうち、完結した UTF-8 文字境界までのバイト長を返す。
/// 末尾 1〜3 バイトがマルチバイトの途中 (0b10xxxxxx が続く / 先頭バイトが continuation を期待)
/// なら、その分だけ削って返す。
///
/// Issue #285 follow-up: scrollback snapshot 取得時にも同じロジックが必要なため pub 化。
/// session.rs の `scrollback_snapshot()` から再利用する (重複定義を避ける)。
pub fn safe_utf8_boundary(buf: &[u8]) -> usize {
    if buf.is_empty() {
        return 0;
    }
    // UTF-8 の先頭バイトから何バイト必要かを計算:
    //   0xxxxxxx: 1 byte
    //   110xxxxx: 2 byte
    //   1110xxxx: 3 byte
    //   11110xxx: 4 byte
    //   10xxxxxx: continuation (先頭としては不正)
    // 末尾最大 3 バイト遡って、先頭バイトが期待するバイト数より足りなければ
    // そこで切る。
    let n = buf.len();
    for back in 1..=4.min(n) {
        let idx = n - back;
        let byte = buf[idx];
        // continuation byte はスキップ
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        // 先頭バイト: 必要なバイト数を読む
        let needed = if byte & 0b1000_0000 == 0 {
            1
        } else if byte & 0b1110_0000 == 0b1100_0000 {
            2
        } else if byte & 0b1111_0000 == 0b1110_0000 {
            3
        } else if byte & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            // 不正バイト → ここでカット (後続で lossy 処理される)
            return idx + 1;
        };
        if back >= needed {
            // 文字が完結している → 末尾まで emit OK
            return n;
        } else {
            // 途中 → この先頭バイトの手前で切る
            return idx;
        }
    }
    // 先頭数バイトが全部 continuation (通常あり得ない)。切らない。
    n
}

#[cfg(test)]
mod boundary_tests {
    use super::safe_utf8_boundary;

    #[test]
    fn ascii_fully_safe() {
        assert_eq!(safe_utf8_boundary(b"hello"), 5);
    }

    #[test]
    fn truncates_at_multibyte_start() {
        // "あ" = E3 81 82, with last 2 bytes missing
        let buf = vec![b'h', b'i', 0xE3];
        assert_eq!(safe_utf8_boundary(&buf), 2);
    }

    #[test]
    fn truncates_with_one_continuation_missing() {
        // 3-byte char started, 2 of 3 present
        let buf = vec![b'x', 0xE3, 0x81];
        assert_eq!(safe_utf8_boundary(&buf), 1);
    }

    #[test]
    fn keeps_complete_multibyte() {
        // "あ" complete
        let buf = vec![b'x', 0xE3, 0x81, 0x82];
        assert_eq!(safe_utf8_boundary(&buf), 4);
    }
}
