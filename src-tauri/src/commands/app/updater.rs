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

/// 現在の UTC 時刻を UNIX epoch からの ms で返す。
///
/// `chrono` 等の追加依存を避けるため `std::time::SystemTime` のみで実装する。
/// `SystemTime::now()` が UNIX_EPOCH より前になるのは時刻巻き戻しの異常時のみで、
/// その場合は 0 を sentinel として返す。`decide_should_warn` はこの `now_ms <= 0` を
/// 「clock 信頼不能」とみなし無条件に警告するため fail-safe に倒れる (Issue #832)。
fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // ~2.9 億年まで i64 ms はオーバーフローしないので as でよい。
    dur.as_millis() as i64
}

/// 現在の UTC 時刻を ISO 8601 (ms 精度, 末尾 "Z") で返す。
///
/// 永続化ファイル (`updater-warned.json`) に書く human-readable 表現。
/// 判定ロジックは round-trip を挟まず `now_unix_ms` を直接使うこと (Issue #832)。
fn now_iso8601_ms() -> String {
    let ms = now_unix_ms();
    format_iso8601_utc(ms / 1000, (ms % 1000) as u32)
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

/// cooldown 判定の純粋ロジック。現在時刻 `now_ms` と直近警告 `last_ms` (どちらも UNIX ms)
/// から「今 toast を出すべきか」を返す。I/O から切り離してテスト可能にするため分離している。
///
/// ## fail-safe 方針 (Issue #609 / #832)
/// この警告は CDN 改竄 / 中間者攻撃の兆候をユーザーに気付かせるセキュリティ通知であり、
/// 「疑わしければ警告」(fail-open) に倒すのが原則。判定は以下の OR:
/// - `now_ms <= 0` → **実時刻が UNIX epoch 以前 = wall clock が信頼できない**。
///   `now_unix_ms` は epoch より前のとき 0 を返す sentinel になっている。この値で
///   cooldown を評価すると、一度 epoch 時刻 (`1970-01-01T00:00:00.000Z`, parse 後 `Some(0)`)
///   が記録された後 `now_ms == prev == 0` の不動点に陥り警告が恒久抑止される。
///   epoch 以前の時刻はそもそも改竄通知を抑止して良い根拠にならないので無条件に警告する。
/// - `last_ms = None` (未通知 / ファイル破損) → 警告
/// - `now_ms < prev` → **時刻逆転を検知**。system clock 巻き戻し、または
///   `updater-warned.json` が未来 timestamp を持つ (破損 / 改竄) ケース。
///   旧実装はここで `now_ms - prev` が負になり cooldown 内と誤判定して警告を恒久抑止していた。
///   時刻が信頼できない以上 cooldown は無効とみなし、毎回警告する (改竄通知を抑止しない)。
/// - 経過が `COOLDOWN_MS` 以上 → 通常の cooldown 満了で警告
///
/// 時刻が逆転している間は毎起動で警告が出るが、これは「clock が壊れている / 操作されている」
/// 異常時の正しい挙動であり、セキュリティ (改竄通知) を anti-spam より優先する。
/// clock が追いついて `now_ms >= prev` に戻れば通常の 24h cooldown に復帰する。
///
/// なお monotonic clock (`Instant`) は epoch を持たずプロセス再起動を跨げないため、
/// 永続化される本 cooldown には使えない。wall-clock の異常検知が唯一の堅牢策。
///
/// オーバーフロー安全のため減算は `saturating_sub` を使う (旧 `now_ms - prev` は
/// 極端な値で panic し得た)。
fn decide_should_warn(now_ms: i64, last_ms: Option<i64>) -> bool {
    // epoch 以前 (= now_unix_ms の sentinel 0、または巻き戻しで負) は clock 信頼不能 → 警告。
    if now_ms <= 0 {
        return true;
    }
    last_ms.map_or(true, |prev| {
        now_ms < prev || now_ms.saturating_sub(prev) >= COOLDOWN_MS
    })
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
    // 文字列化 → 再パースの round-trip を挟まず現在 ms を直接取得する (Issue #832)。
    let now_ms = now_unix_ms();
    let should_warn = decide_should_warn(now_ms, last_ms);
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

    // --- Issue #832: cooldown 判定の clock 異常ケース回帰テスト ---

    /// 警告履歴がない (未通知 / ファイル破損) ときは必ず警告する。
    #[test]
    fn decide_warns_when_never_warned() {
        assert!(decide_should_warn(1_000, None));
    }

    /// 通常: cooldown 満了前は抑止、満了後は警告。
    #[test]
    fn decide_respects_normal_cooldown() {
        let prev = parse_iso8601_to_ms("2026-05-10T00:00:00.000Z").unwrap();
        // 満了 1ms 前 → 抑止
        assert!(!decide_should_warn(prev + COOLDOWN_MS - 1, Some(prev)));
        // ちょうど満了 → 警告
        assert!(decide_should_warn(prev + COOLDOWN_MS, Some(prev)));
        // 満了後 → 警告
        assert!(decide_should_warn(prev + COOLDOWN_MS * 2, Some(prev)));
    }

    /// 同一時刻 (now == prev) は cooldown 内なので抑止 (時刻逆転ではない)。
    #[test]
    fn decide_suppresses_when_now_equals_prev() {
        let prev = parse_iso8601_to_ms("2026-05-10T00:00:00.000Z").unwrap();
        assert!(!decide_should_warn(prev, Some(prev)));
    }

    /// Issue #832: system clock 巻き戻しで now < prev のとき、旧実装は
    /// `now - prev` が負になり警告を恒久抑止していた。fail-safe で必ず警告する。
    #[test]
    fn decide_warns_on_clock_rollback() {
        let prev = parse_iso8601_to_ms("2026-05-10T00:00:00.000Z").unwrap();
        // 1 分巻き戻し
        assert!(decide_should_warn(prev - 60_000, Some(prev)));
        // 大幅巻き戻し (cooldown 1 個分より大きく過去)
        assert!(decide_should_warn(prev - COOLDOWN_MS * 3, Some(prev)));
    }

    /// Issue #832: `updater-warned.json` が未来 timestamp を持つ (破損 / 改竄) と
    /// now < prev になる。これも fail-safe で警告する。
    #[test]
    fn decide_warns_on_future_timestamp() {
        let now = parse_iso8601_to_ms("2026-05-10T00:00:00.000Z").unwrap();
        // 1 年先の未来 timestamp
        assert!(decide_should_warn(now, Some(now + COOLDOWN_MS * 365)));
        // 1ms だけ未来でも逆転扱いで警告 (fail-open 方向)
        assert!(decide_should_warn(now, Some(now + 1)));
    }

    /// Issue #832: 未来時刻で記録された後、clock が正常に戻っても now < prev の間は
    /// 抑止が長期化しないこと (= 毎回警告) を保証する。
    #[test]
    fn decide_does_not_persist_suppression_after_future_record() {
        let now = parse_iso8601_to_ms("2026-05-10T00:00:00.000Z").unwrap();
        let future_prev = now + 10 * COOLDOWN_MS; // 10 日先に記録された
        // clock が追いつくまで (now < future_prev) は毎回警告
        assert!(decide_should_warn(now, Some(future_prev)));
        assert!(decide_should_warn(now + COOLDOWN_MS, Some(future_prev)));
        // clock が prev を追い越したら通常 cooldown に復帰 (満了前は抑止)
        assert!(!decide_should_warn(future_prev + 1, Some(future_prev)));
        assert!(decide_should_warn(future_prev + COOLDOWN_MS, Some(future_prev)));
    }

    /// 極端な値でも saturating_sub によりオーバーフロー panic しないこと。
    /// 旧実装の `now_ms - prev` は debug build で panic し得た。
    #[test]
    fn decide_no_overflow_on_extreme_values() {
        // now=0, prev=i64::MIN: now_ms<=0 ガードで警告 (旧来は saturating_sub で MAX → 警告)
        assert!(decide_should_warn(0, Some(i64::MIN)));
        // now=MAX, prev=0: 経過 = MAX → 警告
        assert!(decide_should_warn(i64::MAX, Some(0)));
        // now=i64::MIN, prev=MAX: now_ms<=0 ガードで警告 (減算は評価されず短絡)
        assert!(decide_should_warn(i64::MIN, Some(i64::MAX)));
    }

    /// Issue #832 (Vector 5): wall clock が UNIX epoch 以前で `now_unix_ms` が sentinel 0 を
    /// 返すとき、cooldown を評価せず必ず警告する。これがないと `now == prev == 0` の不動点で
    /// 改竄通知が恒久抑止され、モジュール doc が約束する fail-open に反する。
    #[test]
    fn decide_warns_when_clock_at_or_before_epoch() {
        // 未通知でも警告 (map_or の true 側にも届くが、ガードが先に効く)
        assert!(decide_should_warn(0, None));
        // 不動点: epoch 時刻が記録済みでも now が epoch なら警告
        assert!(decide_should_warn(0, Some(0)));
        // epoch で未来 timestamp が記録されていても警告
        assert!(decide_should_warn(0, Some(COOLDOWN_MS * 365)));
        // 負値 (理論上の巻き戻し) も警告
        assert!(decide_should_warn(-1, Some(1_000)));
    }

    /// Issue #832 (Vector 5): record → read の epoch round-trip 不動点を end-to-end で検証。
    /// sub-epoch clock 下では `now_iso8601_ms()` が "1970-01-01T00:00:00.000Z" を書き、
    /// それを読み戻すと `Some(0)` になる。この prev と now=0 (sentinel) の組で必ず警告すること。
    #[test]
    fn decide_breaks_epoch_record_read_fixed_point() {
        let recorded = "1970-01-01T00:00:00.000Z"; // sub-epoch clock 下で record が書く文字列
        let prev = parse_iso8601_to_ms(recorded);
        assert_eq!(prev, Some(0), "epoch 文字列は Some(0) に round-trip する");
        let now_ms = 0; // now_unix_ms() の sentinel
        assert!(
            decide_should_warn(now_ms, prev),
            "sub-epoch clock では毎回警告し恒久抑止に陥らないこと"
        );
    }

    /// Issue #832: 破損 / pre-epoch な prev (年 < 1970 が小さい ms に parse される) でも、
    /// 正常な now では経過が cooldown を超えるため警告に倒れる (新たな抑止経路を作らない)。
    #[test]
    fn decide_warns_on_pre_epoch_prev_with_normal_now() {
        // 年 0000 等は下限 year 検証が無いため小さな非負 ms に parse される
        let prev = parse_iso8601_to_ms("0000-01-01T00:00:00.000Z");
        assert_eq!(prev, Some(0));
        let now = parse_iso8601_to_ms("2026-05-10T00:00:00.000Z").unwrap();
        assert!(decide_should_warn(now, prev));
    }

    /// now_unix_ms は単調に進む実時刻 (>= 0) を返す。1970 より後であること。
    #[test]
    fn now_unix_ms_is_positive_and_recent() {
        let now = now_unix_ms();
        assert!(now > 0);
        // 2020-01-01 (1_577_836_800_000 ms) より後であること。
        assert!(now > 1_577_836_800_000);
    }
}
