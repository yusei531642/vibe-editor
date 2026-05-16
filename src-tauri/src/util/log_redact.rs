// Issue #140: bug report やクラッシュリポートに乗るログから、
// ユーザー名 (絶対 home パス) を `~` に置換するヘルパ。
//
// 厳密な PII redaction は別レイヤー (例: Sentry side filter) で行うべきだが、
// 開発者が `tracing::info!` で何気なく path を出してしまうケースに対する
// 一次防御として用意する。
//
// Issue #739: ログ / 診断系の自前ヘルパ重複を本モジュールに集約する:
//   - `reduce_home_prefix` — 旧 `team_hub::state::hub_state` 内に `redact_home` とほぼ
//     同じ実装が重複していたものを移設 (separator 保持の違いがあるため別関数のまま統合)。
//   - `hex_encode` — 旧 `team_hub::mod` 内の自前 hex 変換 (handshake token を hex 化して
//     ログ / 診断に出す用途) を移設。

/// `path` 内に含まれるユーザーホームディレクトリを `~` に置き換えた文字列を返す。
/// home が取れない場合は input をそのまま返す。
pub fn redact_home(path: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return path.to_string();
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

/// home directory プレフィックスを `~` に reduce する。
/// home が解決できない / `s` が home 配下でないときは原文を返す。
///
/// Issue #739: 旧 `team_hub::state::hub_state::reduce_home_prefix` を移設。`redact_home` と
/// 役割は近いが、こちらは「生のまま prefix 一致したら separator を保持する」「Windows
/// case-insensitive 一致は見ない」点が異なる (= `team_diagnostics` の `serverLogPath` 表示で
/// OS ネイティブな区切り文字を保ったまま `~` 化したいケース用)。挙動差を保つため統合しても
/// `redact_home` には寄せず別関数として残す。
pub fn reduce_home_prefix(s: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return s.to_string();
    };
    let home_s = home.to_string_lossy().to_string();
    // Windows では `\` と `/` の混在があり得るので両形で試す
    if let Some(rest) = s.strip_prefix(&home_s) {
        return format!("~{rest}");
    }
    let home_alt = home_s.replace('\\', "/");
    let s_alt = s.replace('\\', "/");
    if let Some(rest) = s_alt.strip_prefix(&home_alt) {
        return format!("~{rest}");
    }
    s.to_string()
}

/// バイト列を小文字 16 進文字列に変換する。
///
/// Issue #739: 旧 `team_hub::mod::hex_encode` を移設。TeamHub の handshake token
/// (24 byte の乱数 → 48 文字の hex) を生成する用途で、生成されたトークンは診断 / ログ
/// 経路にも露出するため、ログ系ヘルパ集約モジュールである本ファイルに置く。
pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{hex_encode, redact_home, reduce_home_prefix};

    #[test]
    fn returns_input_when_no_home_match() {
        let s = redact_home("/usr/local/bin/foo");
        // home が一致しないなら原文かつ slash 正規化のみ
        assert!(s.contains("/usr/local/bin/foo") || s == "/usr/local/bin/foo");
    }

    /// `reduce_home_prefix`: home 配下のパスは `~` に reduce、home 配下でないパスは原文のまま。
    #[test]
    fn reduce_home_prefix_reduces_under_home_and_keeps_outside() {
        if let Some(home) = dirs::home_dir() {
            let inside = home.join("proj").join("a.txt");
            let reduced = reduce_home_prefix(&inside.to_string_lossy());
            assert!(reduced.starts_with('~'), "expected '~' prefix, got: {reduced}");
        }
        // どの OS でも home 配下にならないパスは原文のまま。
        let outside = if cfg!(windows) {
            r"D:\nowhere\elsewhere.log"
        } else {
            "/tmp/elsewhere.log"
        };
        assert_eq!(reduce_home_prefix(outside), outside);
    }

    /// `hex_encode`: 既知バイト列が小文字 hex 文字列になる。長さは入力の 2 倍。
    #[test]
    fn hex_encode_produces_lowercase_hex() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xff, 0xab]), "000fffab");
        assert_eq!(hex_encode(&[]), "");
        let twenty_four = [0xa5u8; 24];
        let encoded = hex_encode(&twenty_four);
        assert_eq!(encoded.len(), 48, "24 bytes → 48 hex chars");
        assert!(encoded.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
