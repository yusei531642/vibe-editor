// Issue #140: ログ redaction とユーティリティの集約モジュール。
pub mod log_redact;

pub mod config_paths;

// Issue #644: settings.json / role-profiles.json の `.bak` 退避を
// タイムスタンプ + 世代回転に共通化する helper。
pub mod backup;
