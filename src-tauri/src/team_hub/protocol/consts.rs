//! `team_hub::protocol` で使用する定数群。Issue #373 Phase 2 で `protocol.rs` から切り出し。

use std::time::Duration;

pub(super) const RECRUIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Issue #342 Phase 1: renderer 側 `app_recruit_ack` invoke 受領を待つ短期タイムアウト。
/// 「addCard / spawn 開始の受領通知」だけを待つので 5s で十分 (handshake 完了までは待たない)。
pub(super) const RECRUIT_ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// 動的ロール instructions の最大長。Leader が暴走して巨大プロンプトを投げてくるのを抑える。
pub(super) const MAX_DYNAMIC_INSTRUCTIONS_LEN: usize = 16 * 1024; // 16 KiB
/// 動的ロール label / description の最大長
pub(super) const MAX_DYNAMIC_LABEL_LEN: usize = 200;
pub(super) const MAX_DYNAMIC_DESCRIPTION_LEN: usize = 1000;
/// チーム 1 つあたりの動的ロール数上限 (DoS 抑止)
pub(super) const MAX_DYNAMIC_ROLES_PER_TEAM: usize = 64;
/// Issue #107: team_send 1 message の最大長 (ハードリミット)。これ以上は呼び出し側を拒否する
/// (単に切ると context が崩れて user 体験が悪いので reject に倒す)。
pub(super) const MAX_MESSAGE_LEN: usize = 64 * 1024; // 64 KiB
/// 「長文ペイロード・ルール」の閾値。これを超えたら `.vibe-team/tmp/<short_id>.md` に
/// 書き出してファイルパスを送るパターンを強制する。
/// inject 側を bracketed-paste 化したので Claude Code は long な貼付けを 1 件として
/// 扱える ようになった。よって閾値は inject の MAX_PAYLOAD と揃えて 32 KiB に拡大。
/// それでも超える本文 (大量の playbook や数十件の YAML) はファイル経由を強制する設計。
pub(super) const SOFT_PAYLOAD_LIMIT: usize = 32 * 1024;
/// Issue #107: チームごとに保持する message 履歴の上限。超過分は古い順に破棄。
/// 件数ベースで持つことで、Hub の長期常駐でメモリが青天井に伸びるのを防ぐ。
pub(super) const MAX_MESSAGES_PER_TEAM: usize = 1000;
/// Issue #107: チームごとに保持する task の上限。超過分は古い順に破棄。
pub(super) const MAX_TASKS_PER_TEAM: usize = 500;
