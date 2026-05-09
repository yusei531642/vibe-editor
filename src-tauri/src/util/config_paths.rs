//! vibe-editor の永続化ディレクトリ・ファイルパスを一元化する helper。
//!
//! すべての関数は `~/.vibe-editor` 直下の決め打ちパスを返すだけで、ディレクトリの作成や
//! 存在確認は行わない。呼び出し側で必要に応じて `fs::create_dir_all` を行うこと。
use std::path::PathBuf;

/// vibe-editor のユーザー設定ルート (`~/.vibe-editor`)。
///
/// Issue #631: 旧実装は `dirs::home_dir().unwrap_or_default()` を返しており、HOME 不在環境
/// (sandbox / CI / サービスアカウント / 環境破損) では空 `PathBuf` にフォールバックしていた。
/// `PathBuf::new().join(".vibe-editor")` は `.vibe-editor` という **相対 path** に解決され、
/// プロセス CWD (= ユーザーのリポジトリ root 等) 配下に paste-images / settings.json 等を書き出し、
/// `cleanup_old_paste_images` が CWD/paste-images/ 配下の古いファイルを 24h で消す事故を起こしていた。
///
/// HOME 不在時は OS の絶対 temp directory (`std::env::temp_dir()`) 配下にフォールバックして
/// 必ず絶対 path を返す。
pub fn vibe_root() -> PathBuf {
    match dirs::home_dir() {
        Some(h) => h.join(".vibe-editor"),
        None => std::env::temp_dir().join("vibe-editor"),
    }
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

/// Issue #661: IDE モード terminal タブの永続化先 `~/.vibe-editor/terminal-tabs.json` のパス。
/// `team-history.json` とは独立した SSOT で、IDE 単独タブの cwd / cols / rows / Claude
/// session id を再起動跨ぎで保持する。
pub fn terminal_tabs_path() -> PathBuf {
    vibe_root().join("terminal-tabs.json")
}
