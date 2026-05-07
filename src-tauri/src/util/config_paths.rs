//! vibe-editor の永続化ディレクトリ・ファイルパスを一元化する helper。
//!
//! すべての関数は `~/.vibe-editor` 直下の決め打ちパスを返すだけで、ディレクトリの作成や
//! 存在確認は行わない。呼び出し側で必要に応じて `fs::create_dir_all` を行うこと。
use std::path::PathBuf;

/// vibe-editor のユーザー設定ルート (`~/.vibe-editor`)。
/// 既存実装と同じく home が解決できない環境では相対 `.vibe-editor` にフォールバックする。
pub fn vibe_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".vibe-editor")
}

/// 設定ファイル `~/.vibe-editor/settings.json` のパス。
pub fn settings_path() -> PathBuf {
    vibe_root().join("settings.json")
}

/// ログ出力先ディレクトリ `~/.vibe-editor/logs`。
pub fn logs_dir() -> PathBuf {
    vibe_root().join("logs")
}

/// TeamHub handoff の永続化先 `~/.vibe-editor/handoffs`。
pub fn handoffs_path() -> PathBuf {
    vibe_root().join("handoffs")
}

/// ロールプロファイル定義ファイル `~/.vibe-editor/role-profiles.json` のパス。
pub fn role_profiles_path() -> PathBuf {
    vibe_root().join("role-profiles.json")
}
