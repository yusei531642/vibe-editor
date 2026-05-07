// PTY 出力バッチャ (旧 lib/pty-data-batcher.ts 等価)
//
// 16ms or 32KB で flush し、ターミナル出力を tauri::Emitter で送る。
// 大量出力時に renderer 側のレンダリングを 60fps 以下に保つため必須。

use crate::pty::scrollback::{append_scrollback, Scrollback};
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
/// PTY reader は 16 KiB/chunk なので、256 枠 ≒ 4 MiB の backpressure buffer。
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
                            // Issue #494: 閾値判定はテストと共有する pure 関数経由。
                            if should_flush_after_recv(buf.len()) {
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
                    if should_flush_on_tick(buf.len()) {
                        flush(&app, &data_event_name, &mut buf, &scrollback);
                    }
                }
            }
        }
    });
}

fn flush(app: &AppHandle, event: &str, buf: &mut BytesMut, scrollback: &Scrollback) {
    let Some(text) = extract_emit_payload(buf, scrollback) else {
        return;
    };
    let len = text.len();
    match app.emit(event, text) {
        Ok(_) => tracing::debug!("[batcher] emit {event} {len}B ok"),
        Err(e) => tracing::warn!("emit {event} failed: {e}"),
    }
}

/// Issue #494: `flush()` から Tauri `app.emit` を除いた pure な部分。
///
/// `buf` の先頭から「UTF-8 として完結しているバイト列」を切り出して `String` を返し、
/// 切り出した分は `buf` から消費する。同時に `scrollback` リングバッファにも push する。
/// emit 対象のバイト列が無い (= empty / 全部マルチバイト途中) 場合は `None`。
///
/// テストから直接呼べるよう `pub(super)`。spawn_batcher の流れと同じ契約に揃えてある:
///   - 末尾がマルチバイト途中 (Issue #48) なら境界手前で切る
///   - in-place 圧縮 (Issue #285 follow-up) で alloc を 1 件減らす
pub(super) fn extract_emit_payload(buf: &mut BytesMut, scrollback: &Scrollback) -> Option<String> {
    if buf.is_empty() {
        return None;
    }
    // Issue #48: buf 末尾がマルチバイト UTF-8 文字の途中だと from_utf8_lossy が
    // U+FFFD に置換してしまう (日本語・絵文字・Box drawing が文字化けする原因)。
    // 末尾から遡って「完結している境界」を見つけ、そこまでを emit、残りは buf に戻す。
    let safe_end = safe_utf8_boundary(buf);
    if safe_end == 0 {
        // 先頭もマルチバイト途中 → 次 flush まで保留 (emit しない)
        return None;
    }
    // Issue #285 follow-up: emit する確定済みバイト列を scrollback にも反映する。
    // 容量超過分は前から drop されるので、attach 経路では「最近 64 KiB」だけ replay される。
    // 旧実装は `buf` を一度 truncate してから scrollback に渡し、remainder を別 Vec に
    // 退避 → emit 後に extend_from_slice で書き戻していた。slice 借用で済む処理を
    // Vec 経由に分割していたため、flush ごとに `remainder.to_vec()` の追加 alloc + memcpy
    // が走っていた。安定 API の copy_within で in-place 圧縮することで、flush あたりの
    // ヒープ allocation を 1 件削減する (60Hz 上限で常時 emit 中は ~60 alloc/s 削減)。
    let emit_slice = &buf[..safe_end];
    append_scrollback(scrollback, emit_slice);
    let text = String::from_utf8_lossy(emit_slice).into_owned();
    let remainder_len = buf.len() - safe_end;
    if remainder_len > 0 {
        buf.copy_within(safe_end.., 0);
    }
    buf.truncate(remainder_len);
    Some(text)
}

/// Issue #494: spawn_batcher の `recv` 側 flush 判定。32 KiB を超えたらフラッシュする
/// 単純な閾値関数。spawn_batcher 内のロジックと統一して、テスト側からも同じ関数で
/// 検証できるようにする。
pub(super) fn should_flush_after_recv(buf_len: usize) -> bool {
    buf_len >= FLUSH_BYTES
}

/// Issue #494: tick (16 ms) 経路で flush するかの判定。tick 自体のタイミングは
/// `tokio::time::interval` が司り、本関数は「buffer に何かあるか?」だけを純粋に判定する。
pub(super) fn should_flush_on_tick(buf_len: usize) -> bool {
    buf_len > 0
}

/// テスト経路用 const アクセサ (production code では `FLUSH_BYTES` / `FLUSH_INTERVAL_MS` を直接参照)。
/// `#[cfg(test)]` でテストビルドにのみ含めることで、lib ビルド側に dead_code 警告を出さない。
#[cfg(test)]
pub(super) const fn flush_bytes_threshold() -> usize {
    FLUSH_BYTES
}

#[cfg(test)]
pub(super) const fn flush_interval_ms() -> u64 {
    FLUSH_INTERVAL_MS
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
