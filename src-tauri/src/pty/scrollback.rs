use crate::pty::batcher::safe_utf8_boundary;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Issue #285 follow-up: attach 経路 (HMR remount) で「既存 PTY の過去出力」を
/// 新しい xterm に replay するための ring buffer 容量上限。
/// Claude / Codex CLI の banner + 数行の prompt が収まる目安として 64 KiB。
/// これ以上はメモリ膨張の懸念があるので前から drop する。
pub const SCROLLBACK_CAPACITY: usize = 64 * 1024;

/// Issue #285 follow-up: attach 経路で renderer に replay するためのリングバッファ。
/// `spawn_batcher` の flush 時に emit と並行して push し、`scrollback_snapshot()` で
/// UTF-8 安全な文字列として取り出す。
pub type Scrollback = Arc<Mutex<VecDeque<u8>>>;

/// Issue #285 follow-up: scrollback に bytes を push し、上限超過分は前から drop する。
/// `spawn_batcher` から flush ごとに呼ばれる。
pub fn append_scrollback(scrollback: &Scrollback, bytes: &[u8]) {
    let mut guard = match scrollback.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            tracing::warn!("[scrollback] mutex poisoned — recovering");
            poisoned.into_inner()
        }
    };
    guard.extend(bytes);
    let overflow = guard.len().saturating_sub(SCROLLBACK_CAPACITY);
    if overflow > 0 {
        guard.drain(..overflow);
    }
}
#[derive(Debug)]
pub(super) struct WriteBudget {
    pub(super) window_started_at: Instant,
    pub(super) bytes_in_window: usize,
}

pub(super) const MAX_TERMINAL_WRITE_BYTES_PER_CALL: usize = 64 * 1024;
pub(super) const MAX_TERMINAL_WRITE_BYTES_PER_SEC: usize = 256 * 1024;
pub(super) const TERMINAL_WRITE_WINDOW: Duration = Duration::from_secs(1);
pub fn new_scrollback() -> Scrollback {
    Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAPACITY)))
}

pub fn scrollback_to_string(scrollback: &Scrollback) -> Option<String> {
    let guard = match scrollback.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            tracing::warn!("[scrollback] snapshot mutex poisoned — recovering");
            poisoned.into_inner()
        }
    };
    if guard.is_empty() {
        return None;
    }
    // VecDeque は連続バイト列ではないので一旦 Vec にコピーする。
    // 上限 64 KiB なので allocation コストは無視できる。
    let bytes: Vec<u8> = guard.iter().copied().collect();
    drop(guard);
    // Codex Lane 4 NIT: 容量超過で前から drain した直後は先頭が UTF-8 continuation バイト
    // (0b10xxxxxx) で始まるケースがある。`String::from_utf8_lossy` は U+FFFD に置換するが、
    // それが画面先頭にゴミとして見えるので、先頭の continuation を skip して文字境界に揃える。
    // 末尾は `safe_utf8_boundary` で従来通り保護する (batcher.rs と共有)。
    let mut start = 0usize;
    while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
        start += 1;
    }
    if start >= bytes.len() {
        return None;
    }
    let safe_end = safe_utf8_boundary(&bytes[start..]) + start;
    if safe_end <= start {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes[start..safe_end]).into_owned();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
#[cfg(test)]
mod scrollback_tests {
    //! Issue #285 follow-up: scrollback ring buffer の挙動を検証する。
    //! `append_scrollback` の容量上限・前から drop・UTF-8 境界保護を担保する。
    use super::*;
    use crate::pty::batcher::safe_utf8_boundary;

    fn make_scrollback() -> Scrollback {
        Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAPACITY)))
    }

    fn snapshot_to_string(scrollback: &Scrollback) -> Option<String> {
        // 本番の `SessionHandle::scrollback_snapshot` と同じロジックを test helper として再現。
        // 先頭 continuation バイト skip + 末尾 safe_utf8_boundary を担保する。
        let guard = scrollback.lock().unwrap();
        if guard.is_empty() {
            return None;
        }
        let bytes: Vec<u8> = guard.iter().copied().collect();
        let mut start = 0usize;
        while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
            start += 1;
        }
        if start >= bytes.len() {
            return None;
        }
        let safe_end = safe_utf8_boundary(&bytes[start..]) + start;
        if safe_end <= start {
            return None;
        }
        Some(String::from_utf8_lossy(&bytes[start..safe_end]).into_owned())
    }

    #[test]
    fn empty_scrollback_returns_none() {
        let sb = make_scrollback();
        assert!(snapshot_to_string(&sb).is_none());
    }

    #[test]
    fn append_keeps_short_payload_intact() {
        let sb = make_scrollback();
        append_scrollback(&sb, b"hello world");
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("hello world"));
    }

    #[test]
    fn append_keeps_japanese_intact() {
        let sb = make_scrollback();
        append_scrollback(&sb, "こんにちは🍣".as_bytes());
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("こんにちは🍣"));
    }

    #[test]
    fn append_drops_oldest_bytes_when_over_capacity() {
        let sb = make_scrollback();
        // 容量ぴったり ASCII で満たしたあと、追加で 100 バイト書く
        let payload_a: Vec<u8> = vec![b'A'; SCROLLBACK_CAPACITY];
        append_scrollback(&sb, &payload_a);
        let extra: Vec<u8> = vec![b'B'; 100];
        append_scrollback(&sb, &extra);

        let snap = snapshot_to_string(&sb).unwrap();
        // 全長は capacity 以下を維持
        assert!(snap.len() <= SCROLLBACK_CAPACITY);
        // 末尾は 'B' で終わる (新しい方が残る)
        assert!(snap.ends_with("BBBBBBBBBB"));
        // 先頭は古い 'A' が drop されているはず (新しい 'B' が末尾 100 バイト分入っている)
        assert!(snap.starts_with('A'));
    }

    #[test]
    fn append_handles_partial_multibyte_at_tail() {
        let sb = make_scrollback();
        // "あ" = E3 81 82。3 バイトのうち 2 バイトだけ append すると snapshot は
        // 直前の確定文字までしか返さない。
        append_scrollback(&sb, b"hi");
        append_scrollback(&sb, &[0xE3, 0x81]);
        // safe_utf8_boundary が末尾 2 バイトを切り捨てる
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("hi"));
        // 残り 1 バイトを追加すると "あ" として正しく取り出せる
        append_scrollback(&sb, &[0x82]);
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("hiあ"));
    }

    #[test]
    fn safe_utf8_boundary_at_complete_char_returns_full_length() {
        let bytes = "abcあ".as_bytes();
        assert_eq!(safe_utf8_boundary(bytes), bytes.len());
    }

    #[test]
    fn safe_utf8_boundary_truncates_middle_of_multibyte() {
        // "abc" + 0xE3 (3 バイト文字の先頭だけ) → 3 バイト目で切る
        let bytes = vec![b'a', b'b', b'c', 0xE3];
        assert_eq!(safe_utf8_boundary(&bytes), 3);
    }

    #[test]
    fn snapshot_skips_leading_continuation_bytes() {
        // Codex Lane 4 NIT: 容量超過 drain 後に先頭が UTF-8 continuation で始まる場合、
        // snapshot は continuation を skip して次の有効な先頭バイトから返す。
        let sb = make_scrollback();
        // "あ" の途中バイト (0x81 0x82) で始まり、続けて完結した "BC" を入れる。
        append_scrollback(&sb, &[0x81, 0x82]);
        append_scrollback(&sb, b"BC");
        // 先頭 2 バイト (continuation) を skip、"BC" だけが取り出される。
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("BC"));
    }

    #[test]
    fn snapshot_returns_none_when_only_continuation_bytes() {
        let sb = make_scrollback();
        append_scrollback(&sb, &[0x80, 0x81, 0x82, 0x83]);
        // 全部 continuation なので skip すると空 → None
        assert!(snapshot_to_string(&sb).is_none());
    }

    #[test]
    fn snapshot_handles_drain_with_partial_leading_multibyte() {
        // 容量上限ギリギリで multi-byte が drain で切れた状況を模擬。
        let sb = make_scrollback();
        // capacity いっぱいの ASCII を入れる
        let payload: Vec<u8> = vec![b'X'; SCROLLBACK_CAPACITY];
        append_scrollback(&sb, &payload);
        // 続けて "あ" (E3 81 82) を入れると最初の X が 3 つ drop される。
        append_scrollback(&sb, "あ".as_bytes());
        // snapshot は X.....あ で終わる正規 UTF-8 列を返す
        let snap = snapshot_to_string(&sb).unwrap();
        assert!(snap.ends_with('あ'));
        assert!(snap.starts_with('X'));
    }
}
