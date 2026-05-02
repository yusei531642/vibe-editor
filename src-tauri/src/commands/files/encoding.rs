/// Issue #102: read 時に検出した encoding で content を再エンコードする。
/// "lossy" / "binary" は保存禁止。空 / "utf-8" は無印 UTF-8。
pub fn encode_for_save(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "" | "utf-8" => Ok(content.as_bytes().to_vec()),
        "utf-8-bom" => {
            let mut out = Vec::with_capacity(content.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(content.as_bytes());
            Ok(out)
        }
        "utf-16le" => {
            let mut out = Vec::with_capacity(content.len() * 2 + 2);
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        "utf-16be" => {
            let mut out = Vec::with_capacity(content.len() * 2 + 2);
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        "utf-32le" => {
            let mut out = Vec::with_capacity(content.len() * 4 + 4);
            out.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x00]);
            for c in content.chars() {
                out.extend_from_slice(&(c as u32).to_le_bytes());
            }
            Ok(out)
        }
        "utf-32be" => {
            let mut out = Vec::with_capacity(content.len() * 4 + 4);
            out.extend_from_slice(&[0x00, 0x00, 0xFE, 0xFF]);
            for c in content.chars() {
                out.extend_from_slice(&(c as u32).to_be_bytes());
            }
            Ok(out)
        }
        // Issue #120: CP932 / Shift_JIS の round-trip 保存。
        // encoding_rs の SHIFT_JIS encoder は CP932 互換 (Windows の機種依存文字も扱える)。
        // unmappable がある場合は HTML 数値参照になるが、それは文字情報を失わずに残せるため
        // 「lossy 拒否」よりも実用的。
        "shift_jis" | "shift-jis" | "sjis" | "cp932" | "windows-31j" => {
            let (cow, _enc, had_unmappable) = encoding_rs::SHIFT_JIS.encode(content);
            // had_unmappable は HTML 数値参照に置換されていることを意味する。それでも書き込みは続行する
            // (元 encoding を維持したい意図のほうが強いケースが多いため)。
            let _ = had_unmappable;
            Ok(cow.into_owned())
        }
        "lossy" => Err(
            "cannot save: file was decoded with replacement characters (original encoding lost)"
                .into(),
        ),
        "binary" => Err("cannot save binary file".into()),
        other => Err(format!("unsupported encoding: {other}")),
    }
}

/// Issue #45: UTF-16 / UTF-32 / CP932 等も「テキスト」として扱えるよう拡張した判定。
/// 戻り値: (is_binary, content, encoding)
pub fn detect_text_or_binary(bytes: &[u8]) -> (bool, String, String) {
    // --- BOM による UTF-16/32 判定 ---
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        // UTF-32 LE BOM (UTF-16 LE と prefix 被るので先にチェック)
        return utf32_decode(&bytes[4..], true)
            .map(|s| (false, s, "utf-32le".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return utf32_decode(&bytes[4..], false)
            .map(|s| (false, s, "utf-32be".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16_decode(&bytes[2..], true)
            .map(|s| (false, s, "utf-16le".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16_decode(&bytes[2..], false)
            .map(|s| (false, s, "utf-16be".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // UTF-8 BOM
        let body = &bytes[3..];
        return match std::str::from_utf8(body) {
            // Issue #102: BOM 付きを保存時にも保持できるよう、明示的に "utf-8-bom" を返す。
            Ok(s) => (false, s.to_string(), "utf-8-bom".to_string()),
            Err(_) => (
                false,
                String::from_utf8_lossy(body).into_owned(),
                "lossy".to_string(),
            ),
        };
    }

    // --- BOM なし: 非テキスト control char の割合で判定 ---
    // 先頭 8KB をサンプリング
    let sample = &bytes[..bytes.len().min(8192)];
    let non_text = sample
        .iter()
        .filter(|&&b| {
            b == 0x00
                || (b < 0x09)
                || b == 0x0B
                || b == 0x0C
                || ((0x0E..0x20).contains(&b) && b != 0x1B) // ESC (0x1B) は xterm 系で許容
        })
        .count();
    // 非テキスト率が 30% を超えるなら binary とみなす
    if !sample.is_empty() && non_text * 100 / sample.len() >= 30 {
        return (true, String::new(), "binary".to_string());
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (false, s.to_string(), "utf-8".to_string()),
        Err(_) => {
            // Issue #120: UTF-8 として無効なら CP932 (Shift_JIS) として復号を試みる。
            // encoding_rs の Shift_JIS は CP932 互換で、Windows の機種依存文字も含む。
            // had_errors=false なら全バイトが妥当な CP932 シーケンスとして解釈できたので
            // テキスト扱いし、save 時も同じ encoding で書き戻して round-trip を成立させる。
            let (cow, _enc, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
            if !had_errors {
                (false, cow.into_owned(), "shift_jis".to_string())
            } else {
                // 最後の砦: UTF-8 lossy で読む。保存は拒否される (元 encoding 不明)。
                (
                    false,
                    String::from_utf8_lossy(bytes).into_owned(),
                    "lossy".to_string(),
                )
            }
        }
    }
}

fn utf16_decode(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let u = if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };
        units.push(u);
    }
    String::from_utf16(&units).ok()
}

fn utf32_decode(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = String::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let u = if little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        match char::from_u32(u) {
            Some(c) => out.push(c),
            None => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod detect_tests {
    use super::detect_text_or_binary;

    #[test]
    fn utf8_ascii_is_text() {
        let (bin, _, enc) = detect_text_or_binary(b"hello world");
        assert!(!bin);
        assert_eq!(enc, "utf-8");
    }

    #[test]
    fn utf16_le_with_bom_is_text() {
        // "hi" in UTF-16 LE with BOM
        let bytes = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let (bin, content, enc) = detect_text_or_binary(&bytes);
        assert!(!bin);
        assert_eq!(content, "hi");
        assert_eq!(enc, "utf-16le");
    }

    #[test]
    fn pure_binary_is_binary() {
        // mostly control bytes
        let bytes: Vec<u8> = (0u8..40).collect();
        let (bin, _, enc) = detect_text_or_binary(&bytes);
        assert!(bin);
        assert_eq!(enc, "binary");
    }

    #[test]
    fn utf8_bom_is_distinguished() {
        // Issue #102: BOM 付き UTF-8 は "utf-8-bom" を返し、保存時に BOM を保てる
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let (bin, content, enc) = detect_text_or_binary(&bytes);
        assert!(!bin);
        assert_eq!(content, "hi");
        assert_eq!(enc, "utf-8-bom");
    }
}

#[cfg(test)]
mod encode_tests {
    use super::encode_for_save;

    #[test]
    fn utf8_no_encoding_is_raw_bytes() {
        let out = encode_for_save("hello", "").unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn utf8_bom_round_trips() {
        let out = encode_for_save("hi", "utf-8-bom").unwrap();
        assert_eq!(&out[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&out[3..], b"hi");
    }

    #[test]
    fn utf16_le_round_trips() {
        let out = encode_for_save("hi", "utf-16le").unwrap();
        assert_eq!(out, [0xFF, 0xFE, b'h', 0x00, b'i', 0x00]);
    }

    #[test]
    fn utf16_be_round_trips() {
        let out = encode_for_save("hi", "utf-16be").unwrap();
        assert_eq!(out, [0xFE, 0xFF, 0x00, b'h', 0x00, b'i']);
    }

    #[test]
    fn lossy_is_rejected() {
        // Issue #102: lossy decode したファイルを保存すると元 encoding を失うため拒否
        assert!(encode_for_save("x", "lossy").is_err());
    }

    #[test]
    fn binary_is_rejected() {
        assert!(encode_for_save("x", "binary").is_err());
    }
}
