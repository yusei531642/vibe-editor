//! Issue #739: 永続化 schema バージョン定数と互換性チェックの集約モジュール。
//!
//! 背景: `settings.json` / `team-state` JSON / `handoffs` checkpoint など複数の永続化
//! ストアがそれぞれ独自に schema version 定数を持ち、互換性ガード (`disk が新しい build で
//! 作られていたら save を拒否する` 等) のロジックも `settings.rs` にしか書かれていなかった。
//! 新しいストアを足す contributor が「どこに version を書き、どう bump 判定するか」を
//! 都度 settings.rs から発掘する必要があった。
//!
//! 本 module は:
//!   - 各ストアの現行 schema version 定数を 1 箇所 (SSOT) に集約する。
//!     既存の `commands::settings::APP_SETTINGS_SCHEMA_VERSION` /
//!     `commands::team_state::TEAM_STATE_SCHEMA_VERSION` は本 module の定数を `pub use`
//!     で re-export しているので、旧 import パスはそのまま使える。
//!   - `SchemaVersion::check_compat` で「disk が未来 schema / incoming が未来 schema」を
//!     拒否する共通互換性ガードを提供する。`settings_save` の #641 ガードはこれ経由になり、
//!     将来 team-state / handoffs に同種ガードを足すときも横展開できる。

use crate::commands::error::{CommandError, CommandResult};

/// `~/.vibe-editor/settings.json` の現行 schema version。
/// renderer 側 `src/types/shared.ts` の `APP_SETTINGS_SCHEMA_VERSION` と同期。
/// Issue #75 / #449 / #618 で bump されてきた。
pub const SETTINGS_SCHEMA_VERSION: u32 = 11;

/// `~/.vibe-editor/team-state/*.json` (TeamHub orchestration state) の現行 schema version。
/// Issue #470 で導入。
pub const TEAM_STATE_SCHEMA_VERSION: u32 = 1;

/// `~/.vibe-editor/handoffs/.../*.json` (leader handoff checkpoint) の現行 schema version。
/// 旧実装は `handoffs.rs` 内に `schema_version: 1` の直書きリテラルだった。
pub const HANDOFF_SCHEMA_VERSION: u32 = 1;

/// 永続化ストア 1 つ分の schema version 情報。`current` (= この build がネイティブに扱える
/// 版数) と、互換性ガードの reject メッセージ / ログに使う `store_label` を束ねる。
#[derive(Clone, Copy, Debug)]
pub struct SchemaVersion {
    /// この build がネイティブに読み書きできる schema version。
    pub current: u32,
    /// reject メッセージ / 監査ログに出すストア名 (例: `"settings.json"`)。
    pub store_label: &'static str,
}

impl SchemaVersion {
    /// `settings.json` 用の `SchemaVersion`。
    pub const SETTINGS: SchemaVersion = SchemaVersion {
        current: SETTINGS_SCHEMA_VERSION,
        store_label: "settings.json",
    };

    /// 永続化前 (= save 直前) の schema version 互換性チェック。
    ///
    /// Issue #641 (旧 `settings.rs::check_schema_compat`) のロジックを共通化したもの。
    /// 以下の 2 ケースで `CommandError::Validation` を返して save を reject する:
    ///
    /// 1. **disk が未来 schema** (`disk_version > current`): 新しい build が作った永続化
    ///    ファイルを、それより古い build が上書きしようとしたケース。古い build の serde は
    ///    新フィールドを silent drop するため、そのまま書き戻すと新フィールドが永久に失われる。
    /// 2. **incoming が未来 schema** (`incoming_version > current`): renderer / migration が
    ///    現行 build の知らない future version を渡してきたケース (改竄ファイル読み込み /
    ///    複数インスタンス race 等の保険)。
    ///
    /// **下回るバージョン (`< current`) は accept する**: renderer 側 migration が現行 schema
    /// へ前進させてから save するのが正常系で、古い disk からの初回 save もこれに含まれる。
    ///
    /// `disk_version` / `incoming_version` が `None` (= ファイル不在 / `schemaVersion` 欠落 /
    /// parse 失敗) のときはガード対象外として `Ok(())` を返す。
    pub fn check_compat(
        &self,
        disk_version: Option<u32>,
        incoming_version: Option<u32>,
    ) -> CommandResult<()> {
        // case 1: 旧 build が新 schema の disk を上書きしようとしている
        if let Some(disk_v) = disk_version {
            if disk_v > self.current {
                tracing::warn!(
                    store = self.store_label,
                    disk_schema_version = disk_v,
                    current_schema_version = self.current,
                    "[schema_version] rejected: disk has newer schema than this build",
                );
                return Err(CommandError::validation(format!(
                    "{} was created by a newer vibe-editor (schema v{disk_v}, this build supports v{}). \
                     Update vibe-editor before saving to avoid losing newer fields.",
                    self.store_label, self.current
                )));
            }
        }
        // case 2: renderer から未来バージョンが渡された
        if let Some(incoming_v) = incoming_version {
            if incoming_v > self.current {
                tracing::warn!(
                    store = self.store_label,
                    incoming_schema_version = incoming_v,
                    current_schema_version = self.current,
                    "[schema_version] rejected: incoming data declares a future schema",
                );
                return Err(CommandError::validation(format!(
                    "Incoming {} declares a future schema (v{incoming_v}, this build supports v{}). \
                     Refusing to overwrite to avoid silent field loss.",
                    self.store_label, self.current
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一 schema (= 通常運用) は accept される。
    #[test]
    fn check_compat_accepts_equal_versions() {
        let r = SchemaVersion::SETTINGS
            .check_compat(Some(SETTINGS_SCHEMA_VERSION), Some(SETTINGS_SCHEMA_VERSION));
        assert!(r.is_ok());
    }

    /// 旧 schema からの save は accept する (renderer migration が前進中 / 古いファイルの初回 save)。
    #[test]
    fn check_compat_accepts_older_versions() {
        let r = SchemaVersion::SETTINGS.check_compat(Some(2), Some(2));
        assert!(r.is_ok(), "older equal schemas must be saveable");
        let r2 = SchemaVersion::SETTINGS.check_compat(Some(5), Some(SETTINGS_SCHEMA_VERSION));
        assert!(r2.is_ok(), "advancing from older disk must be allowed");
    }

    /// disk なし / `schemaVersion` 欠落のときはガード対象外として accept。
    #[test]
    fn check_compat_accepts_missing_disk_version() {
        let r = SchemaVersion::SETTINGS.check_compat(None, Some(SETTINGS_SCHEMA_VERSION));
        assert!(r.is_ok());
        let r2 = SchemaVersion::SETTINGS.check_compat(None, None);
        assert!(r2.is_ok());
    }

    /// disk が新 schema で、incoming が現行 build (= 旧) のとき reject される。
    #[test]
    fn check_compat_rejects_when_disk_has_newer_schema() {
        let future = SETTINGS_SCHEMA_VERSION + 1;
        let r = SchemaVersion::SETTINGS.check_compat(Some(future), Some(SETTINGS_SCHEMA_VERSION));
        assert!(r.is_err(), "disk newer than current build must reject");
        let msg = format!("{}", r.unwrap_err());
        assert!(
            msg.contains("newer vibe-editor"),
            "error message must hint at update: got {msg}"
        );
        assert!(msg.contains("settings.json"), "message must name the store: got {msg}");
    }

    /// renderer から未来バージョンが渡された場合は reject。
    #[test]
    fn check_compat_rejects_when_incoming_is_future_version() {
        let future = SETTINGS_SCHEMA_VERSION + 1;
        let r = SchemaVersion::SETTINGS.check_compat(None, Some(future));
        assert!(r.is_err(), "incoming future schema must reject");
        let msg = format!("{}", r.unwrap_err());
        assert!(
            msg.contains("future schema"),
            "error message must mention future schema: got {msg}"
        );
    }

    /// `store_label` が異なる `SchemaVersion` でもガード判定ロジックは同一。
    #[test]
    fn check_compat_works_for_arbitrary_store() {
        let team_state = SchemaVersion {
            current: TEAM_STATE_SCHEMA_VERSION,
            store_label: "team-state",
        };
        assert!(team_state.check_compat(Some(TEAM_STATE_SCHEMA_VERSION), None).is_ok());
        let r = team_state.check_compat(Some(TEAM_STATE_SCHEMA_VERSION + 1), None);
        assert!(r.is_err());
        assert!(format!("{}", r.unwrap_err()).contains("team-state"));
    }
}
