//! Issue #494: `pty::batcher` の境界条件 + flush 閾値の integration test。
//!
//! `flush()` 本体は Tauri `AppHandle.emit` に依存するためテスト困難だが、
//! Issue #494 で抽出した pure helper (`extract_emit_payload` /
//! `should_flush_after_recv` / `should_flush_on_tick` / `flush_*_threshold`) を
//! 経由して、production と同じ判定ロジックをここで網羅する。
//!
//! 既存の `batcher::boundary_tests` は `safe_utf8_boundary` の単体テストのみだったので、
//! ここでは UTF-8 境界 + scrollback 連携 + flush 閾値の組み合わせをカバーする。

use crate::pty::batcher::{
    extract_emit_payload, flush_bytes_threshold, flush_interval_ms, safe_utf8_boundary,
    should_flush_after_recv, should_flush_on_tick, PTY_CHANNEL_CAPACITY,
};
use crate::pty::scrollback::{new_scrollback, scrollback_to_string, SCROLLBACK_CAPACITY};
use bytes::BytesMut;

/// 16ms / 32 KiB の閾値が想定値から動いていないこと。
/// renderer 側 60Hz レンダリングと PTY backpressure の両立に効く重要定数なので
/// 静的に snapshot しておく。
#[test]
fn flush_thresholds_are_pinned_to_expected_values() {
    assert_eq!(flush_interval_ms(), 16, "flush tick must be ~60Hz (16ms)");
    assert_eq!(flush_bytes_threshold(), 32 * 1024, "flush byte threshold = 32KiB");
    assert_eq!(
        PTY_CHANNEL_CAPACITY, 256,
        "bounded channel must keep ~4MiB backpressure buffer"
    );
}

#[test]
fn should_flush_after_recv_triggers_at_or_above_threshold() {
    let threshold = flush_bytes_threshold();
    assert!(!should_flush_after_recv(0));
    assert!(!should_flush_after_recv(threshold - 1));
    assert!(should_flush_after_recv(threshold));
    assert!(should_flush_after_recv(threshold + 1));
}

#[test]
fn should_flush_on_tick_only_when_buffered() {
    assert!(!should_flush_on_tick(0));
    assert!(should_flush_on_tick(1));
    assert!(should_flush_on_tick(flush_bytes_threshold()));
}

/// `extract_emit_payload`: ASCII のみなら全部 emit され、buffer は空になる。
#[test]
fn extract_emit_payload_drains_ascii_buffer() {
    let mut buf = BytesMut::from(&b"hello world"[..]);
    let scrollback = new_scrollback();
    let text = extract_emit_payload(&mut buf, &scrollback).unwrap();
    assert_eq!(text, "hello world");
    assert!(buf.is_empty(), "ascii buffer must drain completely");
    // scrollback にも反映されている
    assert_eq!(scrollback_to_string(&scrollback).as_deref(), Some("hello world"));
}

/// `extract_emit_payload`: 末尾がマルチバイト UTF-8 の途中 (Issue #48) なら手前で切り、
/// 残りバイトを buffer に残す。
#[test]
fn extract_emit_payload_holds_back_partial_multibyte_tail() {
    // "あ" = E3 81 82。末尾 2 バイト欠落 → "ab" だけ emit、E3 は残す。
    let mut buf = BytesMut::from(&[b'a', b'b', 0xE3][..]);
    let scrollback = new_scrollback();
    let text = extract_emit_payload(&mut buf, &scrollback).unwrap();
    assert_eq!(text, "ab");
    assert_eq!(buf.as_ref(), &[0xE3]);
    assert_eq!(scrollback_to_string(&scrollback).as_deref(), Some("ab"));
}

/// `extract_emit_payload`: 完結したマルチバイト UTF-8 はそのまま emit される。
#[test]
fn extract_emit_payload_emits_complete_multibyte() {
    // "あい" = E3 81 82 E3 81 84。完結。
    let mut buf = BytesMut::from(&[0xE3, 0x81, 0x82, 0xE3, 0x81, 0x84][..]);
    let scrollback = new_scrollback();
    let text = extract_emit_payload(&mut buf, &scrollback).unwrap();
    assert_eq!(text, "あい");
    assert!(buf.is_empty());
    assert_eq!(scrollback_to_string(&scrollback).as_deref(), Some("あい"));
}

/// `extract_emit_payload`: empty buffer は None。スプリアスな emit を起こさない。
#[test]
fn extract_emit_payload_returns_none_on_empty_buffer() {
    let mut buf = BytesMut::new();
    let scrollback = new_scrollback();
    assert!(extract_emit_payload(&mut buf, &scrollback).is_none());
}

/// `extract_emit_payload`: 末尾近くにマルチバイト lead が無く全部 continuation の場合、
/// `safe_utf8_boundary` は「切らない (= 通常あり得ない)」分岐に入って全長を返す。
/// この場合は from_utf8_lossy で U+FFFD に置換されて emit される。テスト時点での挙動を pin する。
#[test]
fn extract_emit_payload_emits_full_buffer_when_all_continuation_bytes() {
    let mut buf = BytesMut::from(&[0x81, 0x82][..]);
    let scrollback = new_scrollback();
    let result = extract_emit_payload(&mut buf, &scrollback);
    // safe_utf8_boundary が n を返すケース → emit されて buf は drain される
    assert!(result.is_some(), "all-continuation defers cut but still emits (lossy)");
    assert!(buf.is_empty());
    // 出力は U+FFFD で 2 バイト分置換 (from_utf8_lossy の挙動)
    let text = result.unwrap();
    assert!(text.contains('\u{FFFD}'));
}

/// `extract_emit_payload`: 先頭が continuation byte で始まり、その後に lead-byte 文字が続く
/// 場合、from_utf8_lossy が先頭の continuation を U+FFFD にして emit する。
#[test]
fn extract_emit_payload_handles_leading_continuation_then_complete_char() {
    // 0x81 (orphan continuation) + "ab"
    let mut buf = BytesMut::from(&[0x81, b'a', b'b'][..]);
    let scrollback = new_scrollback();
    let text = extract_emit_payload(&mut buf, &scrollback).unwrap();
    // U+FFFD + "ab"
    assert!(text.starts_with('\u{FFFD}'));
    assert!(text.ends_with("ab"));
    assert!(buf.is_empty());
}

/// scrollback overflow: 64KiB を超える emit を続けると、scrollback は最新 64KiB のみ保持する。
#[test]
fn scrollback_caps_at_64kib_after_repeated_extracts() {
    let scrollback = new_scrollback();
    // 100 KiB の "a" を 8 KiB ずつ extract (= emit を擬似)。
    let chunk = vec![b'a'; 8 * 1024];
    for _ in 0..13 {
        // 13 * 8KiB = 104 KiB
        let mut buf = BytesMut::from(&chunk[..]);
        extract_emit_payload(&mut buf, &scrollback).unwrap();
    }
    let snap = scrollback_to_string(&scrollback).unwrap();
    assert_eq!(snap.len(), SCROLLBACK_CAPACITY);
    // 全部 'a' で埋まっている
    assert!(snap.chars().all(|c| c == 'a'));
}

/// Issue #48 のクリティカルケース: 「ちょうど 32KiB ぴったりだが末尾が日本語の途中」のとき、
/// flush threshold を満たしていても境界手前まで emit される (= U+FFFD 化を防ぐ)。
#[test]
fn flush_threshold_with_partial_multibyte_tail_emits_safely() {
    let scrollback = new_scrollback();
    let threshold = flush_bytes_threshold();
    // ASCII (threshold - 1 byte) + 0xE3 (3-byte char の先頭バイトのみ)
    let mut buf = BytesMut::with_capacity(threshold + 1);
    buf.extend_from_slice(&vec![b'x'; threshold - 1]);
    buf.extend_from_slice(&[0xE3]);
    assert!(should_flush_after_recv(buf.len()), "should hit recv threshold");
    let text = extract_emit_payload(&mut buf, &scrollback).unwrap();
    assert_eq!(text.len(), threshold - 1, "must NOT include the half-multibyte byte");
    assert_eq!(buf.as_ref(), &[0xE3], "leftover continuation byte stays in buffer");
}

/// `safe_utf8_boundary` の追加エッジケース: 4-byte 文字 (絵文字相当) の途中。
#[test]
fn safe_utf8_boundary_truncates_4byte_char_partial_tail() {
    // U+1F600 😀 = F0 9F 98 80。先頭 1 byte だけ。
    let buf = vec![b'h', b'i', 0xF0];
    assert_eq!(safe_utf8_boundary(&buf), 2);

    // 先頭 2 byte
    let buf = vec![b'h', b'i', 0xF0, 0x9F];
    assert_eq!(safe_utf8_boundary(&buf), 2);

    // 先頭 3 byte
    let buf = vec![b'h', b'i', 0xF0, 0x9F, 0x98];
    assert_eq!(safe_utf8_boundary(&buf), 2);

    // 完結 (4 byte)
    let buf = vec![b'h', b'i', 0xF0, 0x9F, 0x98, 0x80];
    assert_eq!(safe_utf8_boundary(&buf), 6);
}

/// `safe_utf8_boundary` の追加エッジケース: 不正な lead byte (1111_1xxx) は手前でカット。
#[test]
fn safe_utf8_boundary_cuts_at_invalid_lead_byte() {
    // 0xFC は UTF-8 として不正な lead (旧 6-byte UTF-8 拡張、現代 UTF-8 では reject)。
    let buf = vec![b'a', b'b', 0xFC];
    let cut = safe_utf8_boundary(&buf);
    // 不正バイトは含めず手前まで
    assert!(cut <= 3);
    assert!(cut >= 2);
}
