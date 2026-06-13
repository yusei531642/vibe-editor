//! Issue #979: macOS / Linux 専用の PATH 補強。
//!
//! macOS の GUI アプリ (Finder / Dock = launchd 起動) や Linux の `.desktop`
//! ランチャ起動では、ユーザーのログインシェル (`~/.zshrc` / `~/.bash_profile` 等)
//! で設定された PATH を **継承しない**。GUI プロセスの PATH は最小限
//! (`/usr/bin:/bin:/usr/sbin:/sbin` 程度) になるため、`~/.local/bin` や
//! `/opt/homebrew/bin` 等にインストールされた `claude` / `codex` を
//! `which::which` が発見できず「cannot find binary path」になる。
//!
//! ここでは以下を 1 度だけ構築してキャッシュ (`OnceLock`) し、`which` 解決と
//! spawn する子プロセスの `PATH` env に明示注入するための補強済み PATH を返す:
//!
//! 1. ログインシェル経由で取得した実 PATH (`$SHELL -ilc 'printf %s "$PATH"'`)
//! 2. 現在のプロセス PATH
//! 3. 既知 bin ディレクトリ (`~/.local/bin` `/opt/homebrew/bin` `~/.cargo/bin` 等)
//!
//! グローバル env (`std::env::set_var`) は **汚さない**。呼び出し側が
//! `which::which_in` の探索パスと子プロセスの `PATH` に明示的に渡す。
//! Windows は対象外 (`super::windows_resolve` 経路を使う)。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

/// ログインシェル query のタイムアウト。シェルの rc が prompt 待ち等で
/// ハングしても初回 spawn を固めないための保険。
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

static ENRICHED_PATH: OnceLock<String> = OnceLock::new();

/// 補強済み PATH を返す (初回のみ構築してキャッシュ)。
///
/// 戻り値は `:` 区切りの PATH 文字列。空エントリ・重複は除去済みで、
/// 「ログインシェル PATH → プロセス PATH → 既知 bin ディレクトリ」の優先順。
pub(crate) fn enriched_path() -> &'static str {
    ENRICHED_PATH.get_or_init(build_enriched_path)
}

fn build_enriched_path() -> String {
    let mut entries: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // ログインシェルの実 PATH を最優先 (ユーザーの意図を最も正確に反映する)。
    if let Some(login) = login_shell_path() {
        add_path_entries(&login, &mut entries, &mut seen);
    }
    // 次にプロセスが既に持っている PATH。
    if let Ok(current) = std::env::var("PATH") {
        add_path_entries(&current, &mut entries, &mut seen);
    }
    // 最後に既知の bin ディレクトリをフォールバックとして補強。
    for dir in known_bin_dirs() {
        add_path_entries(&dir, &mut entries, &mut seen);
    }

    entries.join(":")
}

/// `:` 区切り (または単一ディレクトリ) の `raw` を分解し、空白除去・重複排除
/// しながら `entries` に push する。順序は維持する。
fn add_path_entries(raw: &str, entries: &mut Vec<String>, seen: &mut HashSet<String>) {
    for part in raw.split(':') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if seen.insert(part.to_string()) {
            entries.push(part.to_string());
        }
    }
}

/// `$SHELL -ilc 'printf %s "$PATH"'` を 1 度だけ実行してログインシェルの
/// 実 PATH を取得する。失敗・タイムアウト・空文字なら `None`。
///
/// - `-i` (interactive) + `-l` (login) で `~/.zshrc` / `~/.bash_profile` 等の
///   PATH 設定を確実に読ませる (VS Code 等の shell-path 系と同じ手法)。
/// - stdin を `/dev/null` に向けてシェルが入力待ちでブロックしないようにする。
/// - 別スレッド + `recv_timeout` でハング時に諦める。
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())?;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let output = std::process::Command::new(&shell)
            .args(["-ilc", "command printf '%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        // 受信側が timeout で去っていても send 失敗を握りつぶすだけ。
        let _ = tx.send(output);
    });

    let output = match rx.recv_timeout(LOGIN_SHELL_TIMEOUT) {
        Ok(Ok(output)) if output.status.success() => output,
        _ => return None,
    };

    let path = String::from_utf8_lossy(&output.stdout);
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// CLI が入りがちな既知 bin ディレクトリ。ログインシェル取得が失敗した
/// 環境でも `claude` / `codex` を拾えるようにするフォールバック。
fn known_bin_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        // ~/.local/bin = Claude Code / Codex のネイティブインストーラ既定先。
        for suffix in [
            ".local/bin",
            ".cargo/bin",
            "bin",
            ".bun/bin",
            ".deno/bin",
            ".volta/bin",
            ".npm-global/bin",
        ] {
            dirs.push(home.join(suffix).to_string_lossy().into_owned());
        }
    }

    for dir in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
    ] {
        dirs.push(dir.to_string());
    }

    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_path_entries_dedups_and_trims() {
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        add_path_entries("/a:/b: /a : :/c", &mut entries, &mut seen);
        add_path_entries("/b:/d", &mut entries, &mut seen);
        assert_eq!(entries, vec!["/a", "/b", "/c", "/d"]);
    }

    #[test]
    fn add_path_entries_skips_empty_input() {
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        add_path_entries("", &mut entries, &mut seen);
        add_path_entries("   ", &mut entries, &mut seen);
        assert!(entries.is_empty());
    }

    #[test]
    fn known_bin_dirs_includes_local_bin() {
        // HOME 依存だが CI/macOS では設定されている前提。少なくとも homebrew 等の
        // 静的エントリは常に含まれる。
        let dirs = known_bin_dirs();
        assert!(dirs.iter().any(|d| d == "/opt/homebrew/bin"));
        assert!(dirs.iter().any(|d| d == "/usr/local/bin"));
    }

    #[test]
    fn enriched_path_is_non_empty_and_cached() {
        let first = enriched_path();
        let second = enriched_path();
        assert!(!first.is_empty());
        // OnceLock キャッシュなので同一インスタンスを指す。
        assert!(std::ptr::eq(first, second));
    }
}
