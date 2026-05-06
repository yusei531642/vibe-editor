use std::path::PathBuf;

/// vibe-editor のユーザー設定ルート (`~/.vibe-editor`)。
/// 既存実装と同じく home が解決できない環境では相対 `.vibe-editor` にフォールバックする。
pub fn vibe_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".vibe-editor")
}

pub fn settings_path() -> PathBuf {
    vibe_root().join("settings.json")
}

pub fn logs_dir() -> PathBuf {
    vibe_root().join("logs")
}

pub fn handoffs_path() -> PathBuf {
    vibe_root().join("handoffs")
}

pub fn role_profiles_path() -> PathBuf {
    vibe_root().join("role-profiles.json")
}
