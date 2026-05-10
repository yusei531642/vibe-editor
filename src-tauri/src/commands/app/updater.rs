//! Issue #609 (Security): Tauri updater の minisign 署名検証失敗を「24h に 1 度だけ」
//! ユーザーに通知するための cooldown 永続化レイヤ。
//!
//! ## 目的
//! `silentCheckForUpdate` が起動時に走り、もし `signature` 系 error を返した場合は
//! - CDN / asset 改竄 / 中間者攻撃の可能性 (= ユーザーに気付かせるべき)
//! - だが renderer 側 toast を毎回出すと spam になり「狼少年」化する
//!
//! という両立要件があるので、`~/.vibe-editor/updater-warned.json` に最終警告 ISO 8601
//! timestamp を書き、24h 経過するまでは renderer 側で toast を出さない。
//!
//! ## ファイル構造
//! ```json
//! { "lastSignatureWarningAt": "2026-05-10T12:34:56.789Z" }
//! ```
//!
//! - 失敗時 (parse 不能 / I/O 失敗) は「未通知」として扱い、renderer に warn=true を返す。
//!   ファイル破損で警告が永久に止まるよりは、再度通知する方が安全側に倒れる。
//! - 永続化は atomic_write で行う (途中クラッシュで空ファイル化を防ぐ)。
//! - 1 セッション内のレース回避は renderer 側で実装する想定 (起動時 1 回しか走らない)。
//!
//! ## なぜ Rust 側で持つか
//! - renderer の zustand persist (= localStorage) では「複数 webview / 別プロセス起動」を跨げない。
//! - settings.json に乗せると settings 全体の merge / migrate と絡んで保守が重くなる。
//! - 単目的の小さい sidecar JSON が一番シンプル。

use crate::commands::atomic_write::atomic_write;
use crate::commands::error::{CommandError, CommandResult};
use crate::util::config_paths::updater_warned_path;
use serde::{Deserialize, Serialize};
use tokio::fs;

/// 24 時間 = 86_400_000 ms。
const COOLDOWN_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterWarnedFile {
    /// 最終 minisign 署名失敗警告の ISO 8601 (UTC, ms 精度) timestamp 文字列。
    /// 未存在 / 空 = まだ一度も警告していない。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_signature_warning_at: Option<String>,
}

/// `app_updater_should_warn_signature` の返り値。
///
/// `should_warn = true` なら renderer 側は toast を出す & 直後に
/// `app_updater_record_signature_warning` を呼んで cooldown を更新する責務を負う。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShouldWarnResult {
    pub should_warn: bool,
    /// 直近の警告 timestamp (ISO 8601)。未通知のときは None。
    /// renderer 側の debugging / 表示用 (UI には今のところ出さない)。
    pub last_warning_at: Option<String>,
}

/// 現在の UTC 時刻を ISO 8601 (ms 精度, 末尾 "Z") で返す。
///
/// `chrono` 等の追加依存を避けるため `std::time::SystemTime` のみで実装する。
fn now_iso8601_ms() -> String {
    // `SystemTime::now()` が UNIX_EPOCH より前になるのは時刻巻き戻しの異常時のみ。
    // その場合は固定文字列を返してもよいが、cooldown 上は「未通知扱い」になるので問題ない。
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let ms = dur.subsec_millis();
    format_iso8601_utc(secs, ms)
}

/// UNIX 秒 + ミリ秒から `YYYY-MM-DDTHH:MM:SS.sssZ` を組み立てる。
///
/// 1970-01-01 起点でグレゴリオ暦を直接計算する小さな実装。閏秒は無視する。
/// 範囲外 (負の secs 等) は EPOCH を返す defensive な挙動。
fn format_iso8601_utc(secs: i64, ms: u32) -> String {
    if secs < 0 {
        return "1970-01-01T00:00:00.000Z".to_string();
    }
    let secs_u = secs as u64;
    let mut days = (secs_u / 86_400) as i64;
    let secs_of_day = (secs_u % 86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // 1970-01-01 から days 日後の (year, month, day) を求める。
    // year を進めながら年内 days を引いていく単純実装 (秒間呼出でも十分高速)。
    let mut year: i64 = 1970;
    loop {
        let yd: i64 = if is_leap_year(year) { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = is_leap_year(year);
    let mdays = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    for &md in &mdays {
        if days < md {
            break;
        }
        days -= md;
        month += 1;
    }
    let day = (days + 1) as u32;

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z"
    )
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// ISO 8601 UTC タイムスタンプ (`YYYY-MM-DDTHH:MM:SS[.sss]Z` 形式) を UNIX ms に変換する。
/// 失敗時は None — その場合 cooldown 判定上は「未通知扱い」として再通知を許可する。
fn parse_iso8601_to_ms(s: &str) -> Option<i64> {
    // YYYY-MM-DDTHH:MM:SS のミニマル parse。タイムゾーン suffix は "Z" のみ受ける。
    let bytes = s.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if !s.ends_with('Z') {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    if &bytes[4..5] != b"-" {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if &bytes[7..8] != b"-" {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if &bytes[10..11] != b"T" {
        return None;
    }
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    if &bytes[13..14] != b":" {
        return None;
    }
    let minute: u32 = s.get(14..16)?.parse().ok()?;
    if &bytes[16..17] != b":" {
        return None;
    }
    let second: u32 = s.get(17..19)?.parse().ok()?;
    let mut ms: u32 = 0;
    let rest = s.get(19..)?;
    if let Some(stripped) = rest.strip_prefix('.') {
        // .sss[Z]
        let until_z = stripped.strip_suffix('Z')?;
        // 1〜9 桁許容、3 桁に丸める
        let trimmed: String = until_z.chars().take(3).collect();
        let pad = format!("{:0<3}", trimmed);
        ms = pad.parse().ok()?;
    } else if rest != "Z" {
        return None;
    }
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    // year/month/day → days since EPOCH
    let mut days: i64 = 0;
    let mut y = 1970i64;
    while y < year {
        days += if is_leap_year(y) { 366 } else { 365 };
        y += 1;
    }
    let leap = is_leap_year(year);
    let mdays = [31u32, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 0..(month - 1) as usize {
        days += mdays[m] as i64;
    }
    days += (day as i64) - 1;
    let secs = days * 86_400 + (hour as i64) * 3600 + (minute as i64) * 60 + (second as i64);
    Some(secs * 1000 + ms as i64)
}

async fn read_warned_file() -> UpdaterWarnedFile {
    let path = updater_warned_path();
    match fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<UpdaterWarnedFile>(&bytes).unwrap_or_default(),
        Err(_) => UpdaterWarnedFile::default(),
    }
}

/// renderer から「signature 系 error を検出したけど toast を出して良いか?」を問い合わせる IPC。
///
/// `should_warn = true` のときだけ renderer は toast を表示する。
/// その後 `app_updater_record_signature_warning` を必ず呼んで cooldown を更新すること。
#[tauri::command]
pub async fn app_updater_should_warn_signature() -> CommandResult<ShouldWarnResult> {
    let file = read_warned_file().await;
    let last_ms = file
        .last_signature_warning_at
        .as_deref()
        .and_then(parse_iso8601_to_ms);
    let now_ms = parse_iso8601_to_ms(&now_iso8601_ms()).unwrap_or(0);
    let should_warn = match last_ms {
        Some(prev) => now_ms - prev >= COOLDOWN_MS,
        None => true,
    };
    Ok(ShouldWarnResult {
        should_warn,
        last_warning_at: file.last_signature_warning_at,
    })
}

/// 警告 toast 表示直後に renderer が呼ぶ。最終警告 timestamp を atomic に更新する。
#[tauri::command]
pub async fn app_updater_record_signature_warning() -> CommandResult<()> {
    let file = UpdaterWarnedFile {
        last_signature_warning_at: Some(now_iso8601_ms()),
    };
    let bytes =
        serde_json::to_vec_pretty(&file).map_err(|e| CommandError::Internal(e.to_string()))?;
    atomic_write(&updater_warned_path(), &bytes)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_round_trip_epoch() {
        let s = format_iso8601_utc(0, 0);
        assert_eq!(s, "1970-01-01T00:00:00.000Z");
        assert_eq!(parse_iso8601_to_ms(&s), Some(0));
    }

    #[test]
    fn iso8601_round_trip_known_date() {
        // parse → format → 同一文字列に戻ることを検証 (具体 secs 値は parse に任せる)。
        let original = "2026-05-10T12:34:56.789Z";
        let ms = parse_iso8601_to_ms(original).expect("parse must succeed");
        let s = format_iso8601_utc(ms / 1000, (ms % 1000) as u32);
        assert_eq!(s, original);
    }

    #[test]
    fn iso8601_leap_day() {
        // 2024 is a leap year — Feb 29 must round-trip
        let s = "2024-02-29T00:00:00.000Z";
        let ms = parse_iso8601_to_ms(s).unwrap();
        assert_eq!(format_iso8601_utc(ms / 1000, (ms % 1000) as u32), s);
    }

    #[test]
    fn iso8601_rejects_non_z_suffix() {
        assert!(parse_iso8601_to_ms("2026-05-10T12:34:56+00:00").is_none());
        assert!(parse_iso8601_to_ms("not-a-timestamp").is_none());
        assert!(parse_iso8601_to_ms("").is_none());
    }

    #[test]
    fn iso8601_accepts_ms_or_no_ms() {
        assert!(parse_iso8601_to_ms("2026-05-10T00:00:00Z").is_some());
        assert!(parse_iso8601_to_ms("2026-05-10T00:00:00.5Z").is_some());
    }

    #[test]
    fn parse_round_trip_preserves_ms_precision() {
        // 3 桁を超える精度は 3 桁に丸められる (parse 側だけで切り詰める)
        let parsed = parse_iso8601_to_ms("2026-05-10T00:00:00.123456789Z").unwrap();
        assert_eq!(parsed % 1000, 123);
    }
}
