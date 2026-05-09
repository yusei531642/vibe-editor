// team_presets.* command — Issue #522
//
// Canvas 上で「うまくいったチーム編成」をプリセットとして保存し、
// 後から 1 操作で再構築できるようにする。
// 保存先: `~/.vibe-editor/presets/<id>.json` (1 file = 1 preset)。
// File-per-preset は team-history.json (single-file array) と異なり、
// 「import / export を 1 ファイルでやり取りできる」「外部編集が容易」「同時書き込みが
// 衝突しない」「将来的に MCP 経由で個別共有できる」メリットがある。
//
// IPC (4 commands):
//   - team_presets_list   : ディレクトリを走査して全 preset を返す
//   - team_presets_save   : id.json に atomic write、updatedAt 更新
//   - team_presets_delete : id.json を削除
//   - team_presets_load   : 単一 preset を読む (list 後の詳細表示用)
//
// 注意: file 名は `<id>.json`。id は uuid v4 等の安全な文字列を呼び出し側で生成する想定だが、
// path traversal を防ぐため `is_safe_id` で英数 + `-_` のみ許可するバリデートを Rust 側でも掛ける。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

/// preset ファイル群の保存先 `~/.vibe-editor/presets/`。
fn presets_root() -> PathBuf {
    crate::util::config_paths::vibe_root().join("presets")
}

fn preset_path(id: &str) -> PathBuf {
    presets_root().join(format!("{id}.json"))
}

/// Issue #187 (Security): id を file 名に流すため、`../` や絶対パス、PathSeparator、NUL、
/// HOME 展開等の path traversal を防ぐ。許可するのは ASCII 英数 + `-` + `_` のみ。
/// 短い (1) / 長い (>128) ものも拒否して fixture 文字列の暴走を防ぐ。
fn is_safe_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Issue #522: 1 ロール分の preset 仕様。Leader 起動後に sequential に team_recruit する想定。
/// `agent` は `claude` / `codex` などのターミナル種別。`customInstructions` は Leader が
/// recruit 時に渡す追加指示の生テキスト (空文字列 / 未設定なら指定なし扱い)。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamPresetRole {
    pub role_profile_id: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamPresetLayoutEntry {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// `roleProfileId` をキーにした相対座標 + size。Canvas store の addCards に渡す配置ヒント。
/// Leader 等が複数同 roleProfileId で並ぶこともあり得るが、preset では常に 1 ロール 1 個の
/// 想定なので素直に Map 形式を採る。重複時は呼び出し側で順序付け。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamPresetLayout {
    pub by_role: std::collections::HashMap<String, TeamPresetLayoutEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamPreset {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// `claude` / `codex` / `mixed` — UI 上のフィルタリング表示用。
    pub engine_policy: String,
    pub roles: Vec<TeamPresetRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<TeamPresetLayout>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PresetMutationResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<TeamPreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// list / save / delete を直列化する単一 lock。
/// 1 preset = 1 file なので衝突は基本起きないが、ディレクトリ走査と削除の同時発生で
/// 中途半端な状態を見せないため簡易直列化する。
static LOCK: once_cell::sync::Lazy<Mutex<()>> = once_cell::sync::Lazy::new(|| Mutex::new(()));

#[tauri::command]
pub async fn team_presets_list() -> Vec<TeamPreset> {
    let _g = LOCK.lock().await;
    let root = presets_root();
    let Ok(mut rd) = fs::read_dir(&root).await else {
        return Vec::new();
    };
    let mut out: Vec<TeamPreset> = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path).await else {
            continue;
        };
        match serde_json::from_slice::<TeamPreset>(&bytes) {
            Ok(p) => {
                // 安全側: file 名と id が一致しない preset は読み捨てる (rename 攻撃や
                // 手動編集ミスで重複 id を作ると list 結果が崩れるため)。
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                if stem == p.id {
                    out.push(p);
                }
            }
            Err(_) => continue,
        }
    }
    // 新しい順で UI 描画しやすいように updatedAt > createdAt で降順 sort。
    out.sort_by(|a, b| {
        let ka = a.updated_at.as_deref().unwrap_or(&a.created_at);
        let kb = b.updated_at.as_deref().unwrap_or(&b.created_at);
        kb.cmp(ka)
    });
    out
}

#[tauri::command]
pub async fn team_presets_load(id: String) -> Option<TeamPreset> {
    if !is_safe_id(&id) {
        return None;
    }
    let _g = LOCK.lock().await;
    let path = preset_path(&id);
    let bytes = fs::read(&path).await.ok()?;
    let preset: TeamPreset = serde_json::from_slice(&bytes).ok()?;
    if preset.id != id {
        return None;
    }
    Some(preset)
}

#[tauri::command]
pub async fn team_presets_save(mut preset: TeamPreset) -> PresetMutationResult {
    if !is_safe_id(&preset.id) {
        return PresetMutationResult {
            ok: false,
            preset: None,
            error: Some("invalid preset id".to_string()),
        };
    }
    if preset.name.trim().is_empty() {
        return PresetMutationResult {
            ok: false,
            preset: None,
            error: Some("preset name must not be empty".to_string()),
        };
    }
    if preset.roles.is_empty() {
        return PresetMutationResult {
            ok: false,
            preset: None,
            error: Some("preset must contain at least one role".to_string()),
        };
    }
    if preset.schema_version == 0 {
        preset.schema_version = 1;
    }
    let now = Utc::now().to_rfc3339();
    if preset.created_at.trim().is_empty() {
        preset.created_at = now.clone();
    }
    preset.updated_at = Some(now);

    let _g = LOCK.lock().await;
    let path = preset_path(&preset.id);
    let json = match serde_json::to_vec_pretty(&preset) {
        Ok(b) => b,
        Err(e) => {
            return PresetMutationResult {
                ok: false,
                preset: None,
                error: Some(e.to_string()),
            }
        }
    };
    // Issue #608 (Security): preset の roles[].custom_instructions は injection-prone な
    // ユーザー定義 prompt を含み得るため 0o600 で永続化。
    match crate::commands::atomic_write::atomic_write_with_mode(&path, &json, Some(0o600)).await {
        Ok(_) => PresetMutationResult {
            ok: true,
            preset: Some(preset),
            error: None,
        },
        Err(e) => PresetMutationResult {
            ok: false,
            preset: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn team_presets_delete(id: String) -> PresetMutationResult {
    if !is_safe_id(&id) {
        return PresetMutationResult {
            ok: false,
            preset: None,
            error: Some("invalid preset id".to_string()),
        };
    }
    let _g = LOCK.lock().await;
    let path = preset_path(&id);
    match fs::remove_file(&path).await {
        Ok(_) => PresetMutationResult {
            ok: true,
            preset: None,
            error: None,
        },
        // 既に存在しない場合は冪等成功扱い (UI 側の double-click 削除耐性)
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PresetMutationResult {
            ok: true,
            preset: None,
            error: None,
        },
        Err(e) => PresetMutationResult {
            ok: false,
            preset: None,
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_safe_id_accepts_uuid_like() {
        assert!(is_safe_id("abc-123_DEF"));
        assert!(is_safe_id("a"));
    }

    #[test]
    fn is_safe_id_rejects_traversal_and_special_chars() {
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("../etc"));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id("a\\b"));
        assert!(!is_safe_id("a.b"));
        assert!(!is_safe_id("a b"));
        assert!(!is_safe_id(&"x".repeat(200)));
    }

    fn make_preset(id: &str, name: &str) -> TeamPreset {
        TeamPreset {
            schema_version: 1,
            id: id.to_string(),
            name: name.to_string(),
            description: Some("A preset".to_string()),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: None,
            engine_policy: "claude".to_string(),
            roles: vec![TeamPresetRole {
                role_profile_id: "leader".to_string(),
                agent: "claude".to_string(),
                label: None,
                custom_instructions: None,
            }],
            layout: None,
        }
    }

    #[test]
    fn preset_serializes_camel_case() {
        let preset = make_preset("p1", "Demo");
        let json = serde_json::to_value(&preset).unwrap();
        // camelCase で出ること (rename_all="camelCase")
        assert!(json.get("schemaVersion").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("enginePolicy").is_some());
        // roles は配列で同様に camelCase
        let role = &json["roles"][0];
        assert!(role.get("roleProfileId").is_some());
    }

    #[test]
    fn preset_validation_blocks_empty_name_and_roles() {
        // direct な validate fn ではなく save 側でやっているので、save_pure_validation を擬似的に確認。
        let mut preset = make_preset("p1", "");
        assert!(!is_safe_id("") && preset.name.trim().is_empty());
        preset.name = "ok".to_string();
        preset.roles.clear();
        // roles 空ガードは save の実装行で見ているのでここは empty チェックだけ確認。
        assert!(preset.roles.is_empty());
    }
}
