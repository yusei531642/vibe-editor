//! Issue #1098: PTY exit イベントの payload 型 (`TerminalExitInfo`) と、その値を
//! 組み立てるための純粋ロジック (exit code の正規化 / 死因可視化用の末尾出力サマリ)。
//!
//! 旧 `handle.rs` 内に置いていた `TerminalExitInfo` を、`spawn.rs` の exit watcher が
//! 使う `normalize_exit_code` / `summarize_exit_tail` と一緒にこの module へ切り出した。
//! 目的:
//! - `handle.rs` を file-size baseline 内に収める (CLAUDE.md item 7)。
//! - exit code 正規化 / ANSI 除去ロジックを副作用なしで単体テストできるようにする。

use serde::Serialize;

/// `terminal:exit:{id}` イベントで renderer に送る payload。
///
/// Issue #1098:
/// - `exit_code` は [`normalize_exit_code`] を通した値。Windows ConPTY が exit(-1) を
///   `u32::MAX` (= 4294967295) として返すケースを -1 に正規化済みなので、renderer は
///   そのまま表示してよい。
/// - `tail` は exit 直前の端末末尾出力を ANSI / 制御列を除去した plain text に圧縮した
///   もの (死因可視化用)。表示に値する出力が無い / scrollback を保持していない場合は
///   `None` で、その場合 serde はフィールドごと省略する (TS 側 `tail?: string`)。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub exit_code: i64,
    pub signal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
}

/// 子プロセスの exit code を表示用に正規化する。
///
/// Windows ConPTY は子プロセスが `exit(-1)` で死んだ場合、`ExitStatus::exit_code()` が
/// 2 の補数表現の `u32` (`0xFFFF_FFFF` = `u32::MAX` = 4294967295) を返す。これをそのまま
/// `as i64` するとバナーに「4294967295」と出て死因が分かりにくい (Issue #1098)。
///
/// 最小スコープとして `u32::MAX` のみ `-1` に正規化する。NTSTATUS (`0xC000_0005` 等) の
/// 一般的な i32 再解釈は行わない (誤って正常な大きい exit code を負値化しないため)。
pub fn normalize_exit_code(raw: u32) -> i64 {
    if raw == u32::MAX {
        -1
    } else {
        i64::from(raw)
    }
}

/// exit 直前の端末末尾出力 (scrollback の plain 文字列) を、バナー表示用に ANSI / 制御列を
/// 除去し直近数行へ圧縮する (Issue #1098, 死因可視化)。
///
/// - CSI (`ESC [ ... 終端`) / OSC (`ESC ] ... BEL or ST`) / その他 `ESC <1byte>` を除去。
/// - CR (`\r`) は「同一行の上書き」を模して、行内の最後の CR 以降だけを残す
///   (claude の `API error · Retrying` のような spinner 上書き行を 1 本に畳む)。
/// - 空行 (trim 後 empty) は捨て、末尾から最大 [`MAX_TAIL_LINES`] 行 / [`MAX_TAIL_CHARS`]
///   文字に収める。
///
/// 表示に値する行が無い (None / 空 / 空白のみ) 場合は `None`。
pub fn summarize_exit_tail(scrollback: Option<&str>) -> Option<String> {
    const MAX_TAIL_LINES: usize = 8;
    const MAX_TAIL_CHARS: usize = 800;

    let cleaned = strip_ansi_control(scrollback?);
    let mut lines: Vec<&str> = Vec::new();
    for line in cleaned.split('\n') {
        // 同一行を CR で上書きする出力は、最後の CR 以降 (= 端末に最終的に見えている内容)
        // だけを採用する。
        let last = line.rsplit('\r').next().unwrap_or(line).trim_end();
        if !last.trim().is_empty() {
            lines.push(last);
        }
    }
    if lines.is_empty() {
        return None;
    }

    let start = lines.len().saturating_sub(MAX_TAIL_LINES);
    let tail = lines[start..].join("\n");
    if tail.chars().count() > MAX_TAIL_CHARS {
        let skip = tail.chars().count() - MAX_TAIL_CHARS;
        let kept: String = tail.chars().skip(skip).collect();
        return Some(format!("…{kept}"));
    }
    Some(tail)
}

/// ANSI escape (CSI / OSC / 2-char ESC) と、CR/LF/TAB 以外の C0/C1 制御文字を取り除く。
/// scrollback は raw な PTY 出力なので、そのまま UI のテキストノードへ出すと
/// `\x1b[33m` 等が文字化けして見えるため、表示前に plain text 化する。
fn strip_ansi_control(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek().copied() {
                // CSI: ESC [ ... 終端バイト (0x40..=0x7E)
                Some('[') => {
                    chars.next();
                    for p in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&p) {
                            break;
                        }
                    }
                }
                // OSC: ESC ] ... 終端は BEL (0x07) または ST (ESC \)
                Some(']') => {
                    chars.next();
                    while let Some(p) = chars.next() {
                        if p == '\u{07}' {
                            break;
                        }
                        if p == '\u{1b}' {
                            if chars.peek().copied() == Some('\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // その他の 2-char ESC sequence: ESC <1 byte> を読み飛ばす
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if c.is_control() && c != '\n' && c != '\r' && c != '\t' {
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_u32_max_to_minus_one() {
        // Windows ConPTY の exit(-1) → 0xFFFFFFFF を -1 に正規化する (Issue #1098 の主目的)。
        assert_eq!(normalize_exit_code(u32::MAX), -1);
    }

    #[test]
    fn normalize_keeps_other_codes() {
        assert_eq!(normalize_exit_code(0), 0);
        assert_eq!(normalize_exit_code(1), 1);
        assert_eq!(normalize_exit_code(127), 127);
        // 最小スコープ: NTSTATUS 風コードは再解釈せず正の値のまま残す。
        assert_eq!(normalize_exit_code(0xC000_0005), 0xC000_0005_i64);
    }

    #[test]
    fn summarize_none_or_blank_is_none() {
        assert_eq!(summarize_exit_tail(None), None);
        assert_eq!(summarize_exit_tail(Some("")), None);
        assert_eq!(summarize_exit_tail(Some("\n\n   \n\t")), None);
    }

    #[test]
    fn summarize_strips_ansi_and_keeps_text() {
        let input = "\x1b[2J\x1b[33mAPI error · Retrying\x1b[0m\nstill failing";
        let out = summarize_exit_tail(Some(input)).expect("non-empty");
        assert!(out.contains("API error · Retrying"), "got: {out:?}");
        assert!(out.contains("still failing"), "got: {out:?}");
        assert!(!out.contains('\u{1b}'), "escape not stripped: {out:?}");
    }

    #[test]
    fn summarize_collapses_cr_overwrite() {
        // spinner が同一行を CR で上書きするケース: 端末に最終的に見える内容だけ残す。
        let out = summarize_exit_tail(Some("loading...\rAPI error · Retrying")).expect("non-empty");
        assert_eq!(out, "API error · Retrying");
    }

    #[test]
    fn summarize_keeps_only_last_lines() {
        let many = (0..40)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let out = summarize_exit_tail(Some(&many)).expect("non-empty");
        assert!(out.lines().count() <= 8, "too many lines: {out:?}");
        assert!(out.contains("line39"), "should keep last line: {out:?}");
        assert!(!out.starts_with("line0"), "should drop oldest line: {out:?}");
    }

    #[test]
    fn summarize_strips_osc_sequence() {
        // OSC (タイトル設定など) は終端の BEL まで丸ごと除去する。
        let out = summarize_exit_tail(Some("\x1b]0;window title\x07done")).expect("non-empty");
        assert_eq!(out, "done");
    }
}
