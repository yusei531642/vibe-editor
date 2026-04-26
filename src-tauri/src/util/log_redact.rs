// Issue #140: bug report やクラッシュリポートに乗るログから、
// ユーザー名 (絶対 home パス) を `~` に置換するヘルパ。
//
// 厳密な PII redaction は別レイヤー (例: Sentry side filter) で行うべきだが、
// 開発者が `tracing::info!` で何気なく path を出してしまうケースに対する
// 一次防御として用意する。

/// `path` 内に含まれるユーザーホームディレクトリを `~` に置き換えた文字列を返す。
/// home が取れない場合は input をそのまま返す。
pub fn redact_home(path: &str) -> String {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return path.to_string(),
    };
    let home_str = home.to_string_lossy();
    if home_str.is_empty() {
        return path.to_string();
    }
    // Windows の case-insensitive 比較 + 区切り違いを揃えてから置換する。
    // 単純な replace でも実用上は十分。
    let normalized_input = path.replace('\\', "/");
    let normalized_home = home_str.replace('\\', "/");
    if let Some(stripped) = normalized_input.strip_prefix(&*normalized_home) {
        return format!("~{stripped}");
    }
    // case-insensitive 一致もチェック (Windows)
    #[cfg(windows)]
    {
        let lower_input = normalized_input.to_ascii_lowercase();
        let lower_home = normalized_home.to_ascii_lowercase();
        if let Some(idx) = lower_input.find(&lower_home) {
            if idx == 0 {
                let rest = &normalized_input[normalized_home.len()..];
                return format!("~{rest}");
            }
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::redact_home;

    #[test]
    fn returns_input_when_no_home_match() {
        let s = redact_home("/usr/local/bin/foo");
        // home が一致しないなら原文かつ slash 正規化のみ
        assert!(s.contains("/usr/local/bin/foo") || s == "/usr/local/bin/foo");
    }
}
