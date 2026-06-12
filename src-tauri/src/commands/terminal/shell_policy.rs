// commands/terminal/shell_policy.rs
//
// Issue #933: シェル引数の安全判定を denylist (即時実行フラグの拒否列挙) から
// 「対話モード限定 allowlist」契約へ反転する。
//
// 旧方式 (`reject_immediate_exec_args`) は「危険なフラグを列挙して拒否」する既定 allow の
// denylist だったため、列挙し損ねたフラグ表記・略記・新シェルが常に素通りし、列挙を増やすと
// 正規ユースを過剰拒否して緩める、という往復が構造的に終わらなかった (#743→#788→#890)。
// さらに「bash /tmp/evil.sh」のような **positional 引数によるスクリプト実行** は
// どの denylist にも引っかからず素通りしていた。
//
// 新方式は信頼境界を実行モデル側に置く:
//   - vibe-editor が起動するシェルは「対話セッション」に限定する
//   - 引数は各シェルの **対話起動フラグの allowlist** に一致するものだけ許可
//   - 一致しないもの (即時実行フラグ・スクリプトパス・未知フラグ) は既定で拒否
//     = 列挙漏れが deny 側に倒れる
//   - 例外は「ユーザーが ~/.vibe-editor/settings.json に明示登録した完全コマンドライン」
//     ([`settings_registered_command_lines`]) との完全一致のみ。フラグ単位の例外は設けない
//
// 対象はシェル (SHELL_BASENAMES) のみ。claude / codex / custom agent はこの契約の対象外で、
// 従来どおり danger-flag 検査 (`command_validation::reject_danger_flags`) 側で守る。

use std::collections::HashSet;

use super::command_validation::{command_basename, split_command_line};

/// `is_allowed_terminal_command` の組み込み allowlist に含まれる汎用シェル。
/// この basename を持つコマンドは「対話モード限定」契約の対象になる。
pub(crate) const SHELL_BASENAMES: &[&str] =
    &["bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd", "nu"];

/// token 先頭の dash 類 (ASCII `-` / `/` および Unicode ダッシュ) を全て剥がした
/// 小文字 stem を返す。PowerShell の `/command` 形式や autocorrect 由来の
/// en dash 表記揺れ (Issue #449) を吸収する。
fn flag_stem(token: &str) -> String {
    token
        .trim()
        .to_ascii_lowercase()
        .trim_start_matches(|c: char| {
            c == '-'
                || c == '/'
                || matches!(
                    c,
                    '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{FE58}' | '\u{FE63}' | '\u{FF0D}'
                )
        })
        .to_string()
}

/// token が dash / slash 始まり (= フラグ形) かどうか。
/// 非フラグ token (スクリプトパス等の positional) の判定に使う。
fn is_flag_like(token: &str) -> bool {
    let t = token.trim();
    t.starts_with('-')
        || t.starts_with('/')
        || t.chars().next().is_some_and(|c| {
            matches!(
                c,
                '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{FE58}' | '\u{FE63}' | '\u{FF0D}'
            )
        })
}

fn non_interactive_msg(token: &str) -> String {
    format!(
        "shell argument is not in the interactive-session allowlist (Issue #933): {token} \
         (shells can only be launched interactively; to opt in, register the full command line \
         in ~/.vibe-editor/settings.json)"
    )
}

/// bash / sh / zsh の対話起動 allowlist。
/// `-` / `--` は bash man にて「引数終端」(無害)、`-i` / `-l` / `--login` は対話・ログイン起動。
/// rcfile 系は「読み込みを抑止する」方向のフラグのみ許可 (値を取るフラグは持ち込まない)。
fn validate_posix_args(args: &[String]) -> Option<String> {
    const EXACT: &[&str] = &[
        "-",
        "--",
        "-i",
        "-l",
        "--login",
        "--interactive",
        "--noprofile",
        "--norc",
        "--noediting",
        "--posix",
    ];
    for raw in args {
        let token = raw.trim().to_ascii_lowercase();
        if EXACT.contains(&token.as_str()) {
            continue;
        }
        // 短オプションクラスタ (`-il` / `-li` 等) は i / l のみで構成されていれば対話系。
        if let Some(cluster) = token.strip_prefix('-') {
            if !cluster.is_empty()
                && !cluster.starts_with('-')
                && cluster.chars().all(|c| matches!(c, 'i' | 'l'))
            {
                continue;
            }
        }
        return Some(non_interactive_msg(raw));
    }
    None
}

/// fish の対話起動 allowlist (`--no-config` / `--private` は設定読み込み抑止系で無害)。
fn validate_fish_args(args: &[String]) -> Option<String> {
    const EXACT: &[&str] = &[
        "-",
        "--",
        "-i",
        "--interactive",
        "-l",
        "--login",
        "-p",
        "--private",
        "-n",
        "--no-config",
    ];
    for raw in args {
        let token = raw.trim().to_ascii_lowercase();
        if EXACT.contains(&token.as_str()) {
            continue;
        }
        if let Some(cluster) = token.strip_prefix('-') {
            if !cluster.is_empty()
                && !cluster.starts_with('-')
                && cluster.chars().all(|c| matches!(c, 'i' | 'l'))
            {
                continue;
            }
        }
        return Some(non_interactive_msg(raw));
    }
    None
}

/// PowerShell (pwsh / powershell) の対話起動 allowlist。
///
/// - 値なしフラグ: `-NoLogo` / `-NoProfile` / `-NoExit` / `-MTA` / `-STA`
///   (+ 広く使われる文書化済み短縮 `-nop`)
/// - 値ありフラグ: `-ExecutionPolicy <policy>` (`-ep` 短縮、`-ep:Bypass` / `-ep=Bypass`
///   の値分離形式も可)。値は既知の policy キーワードのみ許可する
///
/// `-Command` / `-EncodedCommand` / `-File` やその前置略記は allowlist に無いので
/// 既定で拒否される (旧 #890 の「略記列挙」を能動的に追いかける必要がなくなる)。
fn validate_powershell_args(args: &[String]) -> Option<String> {
    const NO_VALUE: &[&str] = &["nologo", "noprofile", "noexit", "nop", "mta", "sta"];
    const VALUE_EP: &[&str] = &["executionpolicy", "ep"];
    const POLICIES: &[&str] = &[
        "restricted",
        "allsigned",
        "remotesigned",
        "unrestricted",
        "bypass",
        "undefined",
        "default",
    ];
    let mut i = 0;
    while i < args.len() {
        let raw = &args[i];
        if !is_flag_like(raw) {
            // positional (スクリプトパス等) は対話セッション契約の外
            return Some(non_interactive_msg(raw));
        }
        let stem_full = flag_stem(raw);
        let mut parts = stem_full.splitn(2, [':', '=']);
        let stem = parts.next().unwrap_or("");
        let inline_value = parts.next();
        if inline_value.is_none() && NO_VALUE.contains(&stem) {
            i += 1;
            continue;
        }
        if VALUE_EP.contains(&stem) {
            if let Some(value) = inline_value {
                if POLICIES.contains(&value) {
                    i += 1;
                    continue;
                }
                return Some(non_interactive_msg(raw));
            }
            // 2 token 形式: 次 token が policy キーワードであることを要求
            if let Some(next) = args.get(i + 1) {
                if POLICIES.contains(&next.trim().to_ascii_lowercase().as_str()) {
                    i += 2;
                    continue;
                }
            }
            return Some(non_interactive_msg(raw));
        }
        return Some(non_interactive_msg(raw));
    }
    None
}

/// cmd.exe の対話起動 allowlist (`/q` echo off / `/d` AutoRun 無効 / `/a` `/u` 出力エンコード /
/// `/v` `/e` `/f` の on|off トグル)。`/c` `/k` は allowlist に無いので既定で拒否される。
fn validate_cmd_args(args: &[String]) -> Option<String> {
    const EXACT: &[&str] = &[
        "/q", "/d", "/a", "/u", "/v:on", "/v:off", "/e:on", "/e:off", "/f:on", "/f:off",
    ];
    for raw in args {
        let token = raw.trim().to_ascii_lowercase();
        if EXACT.contains(&token.as_str()) {
            continue;
        }
        return Some(non_interactive_msg(raw));
    }
    None
}

/// nushell の対話起動 allowlist (login のみ。`-c` / `--commands` / `-e` / `--execute` は
/// allowlist に無いので既定で拒否される)。
fn validate_nu_args(args: &[String]) -> Option<String> {
    const EXACT: &[&str] = &["-l", "--login", "-i", "--interactive"];
    for raw in args {
        let token = raw.trim().to_ascii_lowercase();
        if EXACT.contains(&token.as_str()) {
            continue;
        }
        return Some(non_interactive_msg(raw));
    }
    None
}

/// spawn しようとしている (command, args) を小文字 token 列に正規化する。
/// settings 登録済みコマンドライン ([`registered_command_lines_from_value`]) との
/// 完全一致比較に使う。
fn command_line_tokens(command: &str, args: &[String]) -> Vec<String> {
    let mut tokens = Vec::with_capacity(args.len() + 1);
    tokens.push(command.trim().to_ascii_lowercase());
    tokens.extend(args.iter().map(|a| a.trim().to_ascii_lowercase()));
    tokens
}

/// settings.json の値からユーザーが明示登録した「完全コマンドライン」(小文字 token 列) を
/// 集める。`claudeCommand`+`claudeArgs` / `codexCommand`+`codexArgs` /
/// `customAgents[].command`+`args` の各ペアが 1 エントリになる。
///
/// ここに完全一致するシェル起動は「ユーザー自身が settings に書いた正規 opt-in」として
/// 対話モード契約の例外になる。フラグ単位の例外 (#788 の sanction 方式) と違い、
/// 登録した組合せ以外には一切適用されないため、列挙漏れが既定で deny 側に倒れる。
pub fn registered_command_lines_from_value(
    value: &serde_json::Value,
) -> HashSet<Vec<String>> {
    let mut out = HashSet::new();
    let mut push = |command: Option<&str>, args: Option<&str>| {
        let Some(cmd) = command.map(str::trim).filter(|s| !s.is_empty()) else {
            return;
        };
        let mut tokens = split_command_line(cmd);
        if let Some(a) = args.map(str::trim).filter(|s| !s.is_empty()) {
            tokens.extend(split_command_line(a));
        }
        if tokens.is_empty() {
            return;
        }
        out.insert(
            tokens
                .iter()
                .map(|t| t.to_ascii_lowercase())
                .collect::<Vec<_>>(),
        );
    };
    push(
        value.get("claudeCommand").and_then(|v| v.as_str()),
        value.get("claudeArgs").and_then(|v| v.as_str()),
    );
    push(
        value.get("codexCommand").and_then(|v| v.as_str()),
        value.get("codexArgs").and_then(|v| v.as_str()),
    );
    if let Some(custom) = value.get("customAgents").and_then(|v| v.as_array()) {
        for agent in custom {
            push(
                agent.get("command").and_then(|v| v.as_str()),
                agent.get("args").and_then(|v| v.as_str()),
            );
        }
    }
    out
}

/// `~/.vibe-editor/settings.json` から登録済みコマンドラインを読む。
/// settings.json が無い / parse 失敗の場合は空集合 (= 例外なし) を返す。
/// spawn 境界から spawn 直前にだけ呼ぶ想定 (1 spawn = 1 file read)。
pub fn settings_registered_command_lines() -> HashSet<Vec<String>> {
    let path = crate::util::config_paths::settings_path();
    let Ok(bytes) = std::fs::read(path) else {
        return HashSet::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return HashSet::new();
    };
    registered_command_lines_from_value(&value)
}

/// Issue #933: シェル起動を「対話セッション」に限定する allowlist 契約の本体。
///
/// - command がシェル (SHELL_BASENAMES) でなければ対象外 (None)
/// - (command, args) が settings 登録済みコマンドラインに完全一致すれば許可 (None)
/// - それ以外は各シェルの対話起動 allowlist に **全 token が一致** する場合のみ許可。
///   一致しない最初の token を理由文字列で返す (= 拒否)
pub fn reject_non_interactive_shell_args(
    command: &str,
    args: &[String],
    registered: &HashSet<Vec<String>>,
) -> Option<String> {
    let basename = command_basename(command);
    if !SHELL_BASENAMES.contains(&basename.as_str()) {
        return None;
    }
    if args.is_empty() {
        return None;
    }
    if registered.contains(&command_line_tokens(command, args)) {
        return None;
    }
    match basename.as_str() {
        "bash" | "sh" | "zsh" => validate_posix_args(args),
        "fish" => validate_fish_args(args),
        "pwsh" | "powershell" => validate_powershell_args(args),
        "cmd" => validate_cmd_args(args),
        "nu" => validate_nu_args(args),
        // SHELL_BASENAMES と分岐が乖離した場合は安全側 (拒否) に倒す
        other => Some(non_interactive_msg(other)),
    }
}

#[cfg(test)]
#[path = "shell_policy_tests.rs"]
mod shell_policy_tests;
