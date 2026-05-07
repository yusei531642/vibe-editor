//! `team_hub::protocol` で使用する定数群。Issue #373 Phase 2 で `protocol.rs` から切り出し。
//!
//! Issue #511: 旧 `pub(super)` (= `team_hub::protocol` 配下からのみ可視) では sibling の
//! `team_hub::inject` から参照できず、inject 専用の magic number が `inject.rs` に直書き
//! されたままになっていた。fail-loud 化 + リトライ導入に伴い inject 側も同じ命名規則で
//! tunable を持つ必要があるため、定数の可視性を `pub(crate)` に緩めて `INJECT_*` を集約する。
//! （他クレートには公開しない: 以前と同じく vibe_editor 内部の実装詳細扱い。）

use std::time::Duration;

pub(crate) const RECRUIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Issue #342 Phase 1: renderer 側 `app_recruit_ack` invoke 受領を待つ短期タイムアウト。
/// 「addCard / spawn 開始の受領通知」だけを待つので 5s で十分 (handshake 完了までは待たない)。
pub(crate) const RECRUIT_ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// 動的ロール instructions の最大長。Leader が暴走して巨大プロンプトを投げてくるのを抑える。
pub(crate) const MAX_DYNAMIC_INSTRUCTIONS_LEN: usize = 16 * 1024; // 16 KiB
/// 動的ロール label / description の最大長
pub(crate) const MAX_DYNAMIC_LABEL_LEN: usize = 200;
pub(crate) const MAX_DYNAMIC_DESCRIPTION_LEN: usize = 1000;
/// チーム 1 つあたりの動的ロール数上限 (DoS 抑止)
pub(crate) const MAX_DYNAMIC_ROLES_PER_TEAM: usize = 64;
/// Issue #107: team_send 1 message の最大長 (ハードリミット)。これ以上は呼び出し側を拒否する
/// (単に切ると context が崩れて user 体験が悪いので reject に倒す)。
pub(crate) const MAX_MESSAGE_LEN: usize = 64 * 1024; // 64 KiB
/// 「長文ペイロード・ルール」の閾値。これを超えたら `.vibe-team/tmp/<short_id>.md` に
/// 書き出してファイルパスを送るパターンを強制する。
/// inject 側を bracketed-paste 化したので Claude Code は long な貼付けを 1 件として
/// 扱える ようになった。よって閾値は inject の MAX_PAYLOAD と揃えて 32 KiB に拡大。
/// それでも超える本文 (大量の playbook や数十件の YAML) はファイル経由を強制する設計。
pub(crate) const SOFT_PAYLOAD_LIMIT: usize = 32 * 1024;
/// Issue #107: チームごとに保持する message 履歴の上限。超過分は古い順に破棄。
/// 件数ベースで持つことで、Hub の長期常駐でメモリが青天井に伸びるのを防ぐ。
pub(crate) const MAX_MESSAGES_PER_TEAM: usize = 1000;
/// Issue #107: チームごとに保持する task の上限。超過分は古い順に破棄。
pub(crate) const MAX_TASKS_PER_TEAM: usize = 500;

// ---------- Issue #511: PTY inject (`team_hub::inject`) tunables ----------
//
// 旧 `inject.rs` 内の magic number を集約。「ConPTY バッファ事故を避けるための
// 64B / 15ms チャンク化」「bracketed paste の上限 32 KiB」「自動リトライの 1 回
// 限り / 200ms backoff」を 1 箇所で調整できるようにする。

/// PTY 1 回の write に流す最大バイト数。ConPTY のリングバッファ事故を避ける目的で
/// 旧 `inject::CHUNK_SIZE` から移設。値の根拠は portable-pty の Windows 実装が
/// ~256B 以下で安定動作するという経験則 (旧コード由来)。
pub(crate) const INJECT_CHUNK_SIZE: usize = 64;
/// チャンク間スリープ。Claude/Codex 側の TUI が paste sequence を 1 件として
/// バンドルする時間的余裕を確保する。
pub(crate) const INJECT_CHUNK_DELAY_MS: u64 = 15;
/// bracketed paste 領域に詰められる本文 (banner + body) の最大バイト数。
/// `SOFT_PAYLOAD_LIMIT` と意図的に揃えてある (送信側で 32 KiB を弾くため事実上等価)。
pub(crate) const INJECT_MAX_PAYLOAD: usize = 32 * 1024;
/// 自動リトライ回数の上限。Issue #511 で導入。
/// **NoSession / WriteInitialFailed のみ** リトライ対象 (= 1 byte も書いていないとき)。
/// 本文を 1 byte でも送ったあとに失敗した場合は二重 paste 事故を避けるためリトライしない。
pub(crate) const INJECT_MAX_RETRY: u32 = 1;
/// リトライ前の backoff (millis)。session が ack されきっていない初期 race 用。
pub(crate) const INJECT_RETRY_BACKOFF_MS: u64 = 200;

// ---------- Issue #524: status staleness threshold ----------

/// `team_status` 自己申告 (= `last_status_at`) からこの秒数以上更新が無ければ、
/// `team_diagnostics` の `autoStale: true` を立てる。
/// 5 分は「主要 shell コマンド (cargo build / npm test / 長めの Claude 思考) より長く、
/// かつ 30 分のような長すぎる threshold で督促が遅れる事故を避けた中間値」。
pub(crate) const STATUS_STALE_THRESHOLD_SECS: u64 = 300;

// ---------- Issue #512: long-payload spool ----------
//
// `team_send` / `team_assign_task` が `SOFT_PAYLOAD_LIMIT` (32 KiB) を超える本文を受け取ったとき、
// silent reject ではなく project_root 配下の spool ディレクトリに書き出して、Hub から worker へは
// 「summary + attached: <path>」の短文だけを inject する。長文を fail-loud から「安全に分流」させる。

/// project_root 直下の spool ディレクトリ (= `<project_root>/.vibe-team/tmp/`)。
/// renderer 側の SKILL.md が以前から「`.vibe-team/tmp/<short_id>.md` に書き出す」と
/// 案内していた path と整合させ、ユーザーが手動で書いた spool ファイルと Hub が自動で
/// 書いた spool ファイルが同じ directory に混在しても困らない設計にする。
pub(crate) const SPOOL_DIR: &str = ".vibe-team/tmp";

/// spool ファイルの保持時間 (時間単位)。Hub 起動時 + 24 時間ごとに古い entry を削除する。
/// 24 時間あれば worker が読み終えていない可能性は低く、long-running session でも安全。
pub(crate) const SPOOL_TTL_HOURS: u64 = 24;

/// spool 化された場合に inject 本文の冒頭に残す summary 行数の上限。
/// 80 行あれば「最初の指示 + 最初の参照」が見える程度の preview になり、
/// worker が「全文を読まなくても全体像を掴めて attach を読み込みに行く」動機を作る。
pub(crate) const SPOOL_SUMMARY_LINES: usize = 80;
