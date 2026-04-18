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
pub fn spawn_batcher(
    app: AppHandle,
    data_event_name: String,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
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
                            // reader thread が exit。最後にまとめて flush。
                            flush(&app, &data_event_name, &mut buf);
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

fn flush(app: &AppHandle, event: &str, buf: &mut BytesMut) {
    if buf.is_empty() {
        return;
    }
    let len = buf.len();
    // PTY は ANSI シーケンスを含む可能性。utf-8 不正バイトは lossy で許容。
    let text = String::from_utf8_lossy(buf).into_owned();
    match app.emit(event, text) {
        Ok(_) => tracing::debug!("[batcher] emit {event} {len}B ok"),
        Err(e) => tracing::warn!("emit {event} failed: {e}"),
    }
    buf.clear();
}
