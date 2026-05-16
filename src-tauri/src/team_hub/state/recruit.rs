//! recruit / pending recruit / handshake grant / ack / recruit semaphore に関する
//! 型・const・env ヘルパ・`TeamHub` impl。
//!
//! Issue #736: 旧 `state.rs` から recruit 関連を切り出し。
//! Issue #742 (Security): handshake grant の TTL / single-use / agent_id binding を含む。

use crate::team_hub::error::{AckError, AckFailPhase};
use crate::team_hub::TeamHub;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

use super::member_diagnostics::MemberDiagnostics;

const RECRUIT_GRACE_DEFAULT_MS: u64 = 2_000;
const RECRUIT_GRACE_MAX_MS: u64 = 10_000;

/// Issue #742 (Security): recruit grant (= 事前発行された pending recruit) の有効期限。
/// `try_register_pending_recruit` で agent_id を登録した瞬間から計時し、handshake が
/// この時間内に来なければ「期限切れ token」として reject する。短い TTL により、
/// `VIBE_TEAM_TOKEN` を盗んだ別プロセスが「子プロセスが起動に失敗して未 handshake のまま
/// 放置された grant」を後から悪用できる窓を最小化する。
/// recruit フロー自体の `RECRUIT_TIMEOUT` (30s) より長めの 60s を既定にして、
/// recruit-timeout 側 cleanup の belt に対する suspenders として機能させる。
/// `VIBE_TEAM_HANDSHAKE_TTL_MS` で上書き可能 (parse 失敗 / 範囲外 / 未設定は既定値)。
const HANDSHAKE_GRANT_TTL_DEFAULT_MS: u64 = 60_000;
/// TTL の許容上限。これより大きい env 値は無効として既定値に丸める
/// (TTL を実質無効化するような巨大値の誤設定 / 改ざんを防ぐ)。
const HANDSHAKE_GRANT_TTL_MAX_MS: u64 = 300_000;

#[cfg(test)]
pub(super) static RECRUIT_RESCUED_EVENTS_FOR_TEST: once_cell::sync::Lazy<
    std::sync::Mutex<Vec<RecruitRescuedPayload>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(Vec::new()));

#[derive(Clone, Debug)]
pub struct RecruitOutcome {
    pub agent_id: String,
    pub role_profile_id: String,
}

/// pending_recruits の値。team_id と role を保持して、並行 recruit でも整合性のある
/// 人数 / singleton 判定ができるようにする (Issue #122)。
///
/// Issue #342 Phase 1: ack 駆動への移行に伴い、以下を追加:
/// - `requester_agent_id`: ack 認可ガード時の診断ログ用 (誰の recruit が落ちたか追跡可能にする)
/// - `ack_tx`: renderer の `app_recruit_ack` invoke を待つための oneshot。受領通知のみで
///   handshake 完了は別経路 (`tx`) で待つ。
/// - `ack_done`: 重複 ack を弾くための AtomicBool。renderer のバグや競合で 2 回 ack が来ても
///   2 回目以降は no-op になる。
pub struct PendingRecruit {
    pub team_id: String,
    pub role_profile_id: String,
    pub requester_agent_id: String,
    pub tx: oneshot::Sender<RecruitOutcome>,
    pub ack_tx: Option<oneshot::Sender<RecruitAckOutcome>>,
    pub ack_done: AtomicBool,
    /// Issue #577: ack timeout 済みだが grace window 中で、遅着 ack を rescue できる状態。
    pub timed_out_at: Option<Instant>,
    /// Issue #742 (Security): この recruit grant を発行した時刻。
    /// `resolve_pending_recruit` の handshake で `issued_at.elapsed()` が
    /// `HANDSHAKE_GRANT_TTL` を超えていたら「期限切れ token」として reject する
    /// (未使用 token を短時間で無効化 = 盗まれた token の有効窓を絞る)。
    pub issued_at: Instant,
}

/// Issue #577: timeout 後 grace 期間中に遅着 ack を救済したことを renderer に知らせる event payload。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecruitRescuedPayload {
    pub new_agent_id: String,
    pub late_by_ms: u64,
}

/// Issue #342 Phase 1: renderer から `app_recruit_ack` で渡される受領通知 outcome。
///
/// `ok=true` は「renderer が `team:recruit-request` を受け取って addCard / spawn を開始した」
/// という受領通知のみ。**handshake 完了ではない**。真の成功判定は既存の
/// `resolve_pending_recruit` (handshake 経由) で行う。
///
/// `ok=false` の場合は `phase` に失敗種別 (spawn / engine_binary_missing / 等) が入り、
/// `reason` に追加情報 (任意の文字列、長さ 256 byte 上限) が入る。
#[derive(Clone, Debug)]
pub struct RecruitAckOutcome {
    pub ok: bool,
    pub reason: Option<String>,
    pub phase: Option<AckFailPhase>,
}

/// Issue #342 Phase 1: `try_register_pending_recruit` が返す 2 系統の Receiver。
///
/// - `ack`: renderer から `app_recruit_ack` invoke が来たら resolve される短期 (5s) 待機用
/// - `handshake`: spawn された agent が socket / pipe で handshake を済ませると resolve される
///   長期 (30s) 待機用 (既存 `resolve_pending_recruit` 経路)
pub struct PendingRecruitChannels {
    pub handshake: oneshot::Receiver<RecruitOutcome>,
    pub ack: oneshot::Receiver<RecruitAckOutcome>,
}

impl TeamHub {
    /// recruit を pending に登録する。Issue #122: 「singleton 判定」と「pending 登録」を
    /// 同じクリティカルセクションで行うことで並行 recruit による singleton 重複を防ぐ。
    ///
    /// Issue #386: 1 チームあたりのメンバー人数上限は撤廃済み。
    ///
    /// `current_members` は呼び出し側で先に取得した「handshake 済みメンバー (agent_id, role) の一覧」。
    /// クリティカルセクション内で pending と合わせて役職重複をチェックし、
    /// パスしたらこの場で pending に挿入して Receiver を返す。
    pub async fn try_register_pending_recruit(
        &self,
        agent_id: String,
        team_id: String,
        role_profile_id: String,
        requester_agent_id: String,
        is_singleton: bool,
        current_members: &[(String, String)],
    ) -> Result<PendingRecruitChannels, String> {
        let (tx, rx) = oneshot::channel();
        let (ack_tx, ack_rx) = oneshot::channel();
        let mut s = self.state.lock().await;
        // 同 team_id に属する pending を列挙
        let pending_for_team: Vec<&PendingRecruit> = s
            .pending_recruits
            .values()
            .filter(|p| p.team_id == team_id)
            .collect();
        // singleton チェック (handshake 済み + pending を両方見る)
        if is_singleton {
            let already = current_members.iter().any(|(_, r)| r == &role_profile_id)
                || pending_for_team
                    .iter()
                    .any(|p| p.role_profile_id == role_profile_id);
            if already {
                return Err(format!(
                    "singleton role '{role_profile_id}' is already filled or pending in this team"
                ));
            }
        }
        // Issue #342 Phase 3 (3.3): recruit 時の診断 entry を初期化。
        // recruited_at は新規上書き (再 recruit を可視化)、他 timestamp/counter は default で初期化。
        let now_iso = chrono::Utc::now().to_rfc3339();
        s.member_diagnostics.insert(
            agent_id.clone(),
            MemberDiagnostics {
                recruited_at: now_iso,
                ..MemberDiagnostics::default()
            },
        );
        s.pending_recruits.insert(
            agent_id,
            PendingRecruit {
                team_id,
                role_profile_id,
                requester_agent_id,
                tx,
                ack_tx: Some(ack_tx),
                ack_done: AtomicBool::new(false),
                timed_out_at: None,
                // Issue #742: grant 発行時刻。handshake TTL 検証の起点。
                issued_at: Instant::now(),
            },
        );
        Ok(PendingRecruitChannels {
            handshake: rx,
            ack: ack_rx,
        })
    }

    /// handshake 内で agent_id がマッチしたら呼ぶ。recruit が待機中ならここで resolve。
    /// Issue #183: client が送ってきた role が
    ///   1. pending recruit の予約 role と一致するか (新規 recruit 経路)
    ///   2. 既存 agent_role_bindings に bind 済み role と一致するか (再接続経路)
    ///
    /// を照合する。どちらも不一致なら false を返してハンドラ側で接続切断。
    /// 初回 handshake が成功したら agent_id → role を bind する。
    ///
    /// Issue #342 Phase 2: `team_id` も照合対象に追加。pending の `team_id` と
    /// handshake で送られてきた `team_id` が一致しない場合は false を返して接続を切る
    /// (cross-team 偽 handshake / 旧 context 残骸の混線を防ぐ)。
    ///
    /// Issue #637: `agent_role_bindings` の key を `(team_id, agent_id)` tuple に拡張。
    /// 同 agent_id が別 team で handshake してきても old team の binding を上書きしない
    /// (cross-team race の遮断)。lookup / insert は team_id ペアで行う。
    ///
    /// Issue #742 (Security): handshake を「Hub が事前発行した recruit grant の照合」に格上げする。
    /// 1. **TTL**: pending grant が `HANDSHAKE_GRANT_TTL` を超過していたら期限切れ token として
    ///    reject し、stale な pending entry をその場で除去する (未使用 token の有効窓を最小化)。
    /// 2. **single-use**: pending entry は初回 handshake 成功で `remove` される (旧来挙動)。
    ///    同 grant での 2 回目以降はこの remove 済み状態のため pending 経路には乗らない。
    /// 3. **agent_id binding**: pending grant も既存 binding も無い「未知 agent_id」は reject する。
    ///    旧実装は未知 agent_id でも binding を新規作成して `true` を返していたため、正しい
    ///    global token さえあれば任意の偽 agent_id で接続できた。Hub が `try_register_pending_recruit`
    ///    で事前発行した agent_id (= pending) か、過去に handshake 済みの agent_id (= binding) の
    ///    いずれかでなければ通さない。
    pub async fn resolve_pending_recruit(
        &self,
        agent_id: &str,
        team_id: &str,
        role_profile_id: &str,
    ) -> bool {
        self.resolve_pending_recruit_with_ttl(
            agent_id,
            team_id,
            role_profile_id,
            handshake_grant_ttl_from_env(),
        )
        .await
    }

    /// Issue #742: TTL を引数で受ける本体。test から短い TTL を注入して期限切れ経路を
    /// 検証できるようにするため `resolve_pending_recruit` から分離した。
    pub(crate) async fn resolve_pending_recruit_with_ttl(
        &self,
        agent_id: &str,
        team_id: &str,
        role_profile_id: &str,
        grant_ttl: Duration,
    ) -> bool {
        let mut s = self.state.lock().await;
        // Issue #742: pending grant が存在するなら TTL / team_id / role を順に検証する。
        let mut consumed_pending = false;
        if let Some(p) = s.pending_recruits.get(agent_id) {
            // TTL 超過 = 期限切れ token。stale entry を除去してから reject する
            // (recruit 側 cancel 経路が拾えなかった残骸を handshake 側でも掃除)。
            if p.issued_at.elapsed() > grant_ttl {
                tracing::warn!(
                    "[teamhub] handshake rejected: recruit grant expired \
                     (agent={agent_id} team={team_id} age={:?} ttl={grant_ttl:?})",
                    p.issued_at.elapsed()
                );
                s.pending_recruits.remove(agent_id);
                return false;
            }
            if p.team_id != team_id {
                tracing::warn!(
                    "[teamhub] team_id mismatch on handshake (pending) agent={} expected={} got={}",
                    agent_id,
                    p.team_id,
                    team_id
                );
                return false;
            }
            if p.role_profile_id != role_profile_id {
                tracing::warn!(
                    "[teamhub] role mismatch on handshake (pending) agent={} expected={} got={}",
                    agent_id,
                    p.role_profile_id,
                    role_profile_id
                );
                return false;
            }
            // single-use: 成功確定なので grant を消費 (remove) する。
            let p = s.pending_recruits.remove(agent_id).expect("just checked");
            let _ = p.tx.send(RecruitOutcome {
                agent_id: agent_id.to_string(),
                role_profile_id: role_profile_id.to_string(),
            });
            consumed_pending = true;
        }
        // 既に bind 済みの (team_id, agent_id) なら role 一致を強制。
        // Issue #637: team_id 次元で分離しているので、別 team の同 agent_id binding は
        // この lookup に引っかからず、上書きで old team の role が消えることもない。
        let binding_key = (team_id.to_string(), agent_id.to_string());
        if let Some(bound) = s.agent_role_bindings.get(&binding_key) {
            if bound != role_profile_id {
                tracing::warn!(
                    "[teamhub] role mismatch on handshake (rebind) team={} agent={} bound={} got={}",
                    team_id,
                    agent_id,
                    bound,
                    role_profile_id
                );
                return false;
            }
        } else if consumed_pending {
            // 初回 handshake: たった今 grant を消費したので bind を確立する。
            // 以後の再接続 (bridge の onClose→connect) はこの binding 経路で許可される。
            s.agent_role_bindings
                .insert(binding_key, role_profile_id.to_string());
        } else {
            // Issue #742: pending grant も binding も無い = Hub が発行していない未知 agent_id。
            // 正しい global token を持っていても、ここで reject して接続を切る。
            tracing::warn!(
                "[teamhub] handshake rejected: unknown agent_id (no pending grant, no binding) \
                 team={team_id} agent={agent_id}"
            );
            return false;
        }
        // Issue #342 Phase 3 (3.3): 初回 handshake / 再接続 handshake いずれも last_handshake_at と
        // last_seen_at を更新する。recruit 経路を通らずに直接 handshake してきた場合 (= 旧 context
        // 残骸の再接続等) は entry が無いので or_default で生成する。
        let now_iso = chrono::Utc::now().to_rfc3339();
        let entry = s
            .member_diagnostics
            .entry(agent_id.to_string())
            .or_default();
        if entry.recruited_at.is_empty() {
            entry.recruited_at = now_iso.clone();
        }
        entry.last_handshake_at = Some(now_iso.clone());
        entry.last_seen_at = Some(now_iso);
        true
    }

    /// timeout 等でキャンセル: ack channel は即時 close しつつ、短い grace window 中は
    /// pending を残して renderer からの遅着 ack を rescue できるようにする (Issue #577)。
    pub async fn cancel_pending_recruit(&self, agent_id: &str) {
        self.cancel_pending_recruit_with_grace(agent_id, recruit_grace_from_env())
            .await;
    }

    async fn cancel_pending_recruit_with_grace(&self, agent_id: &str, grace: Duration) {
        let timed_out_at = Instant::now();
        let should_schedule_cleanup = {
            let mut s = self.state.lock().await;
            let Some(pending) = s.pending_recruits.get_mut(agent_id) else {
                return;
            };

            // 既に timeout 済みなら idempotent に扱う。重複 cleanup task を増やさない。
            if pending.timed_out_at.is_some() {
                return;
            }

            // ack waiter には従来どおり Err を返すため、ack_tx は timeout 時点で close する。
            let _ = pending.ack_tx.take();

            if grace.is_zero() {
                // VIBE_TEAM_RECRUIT_GRACE_MS=0 は旧挙動互換: 即時に pending を破棄する。
                s.pending_recruits.remove(agent_id);
                false
            } else {
                pending.timed_out_at = Some(timed_out_at);
                true
            }
        };

        if should_schedule_cleanup {
            let hub = self.clone();
            let agent_id = agent_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                let mut s = hub.state.lock().await;
                let should_remove = s
                    .pending_recruits
                    .get(&agent_id)
                    .and_then(|p| p.timed_out_at)
                    .is_some_and(|ts| ts == timed_out_at);
                if should_remove {
                    s.pending_recruits.remove(&agent_id);
                }
            });
        }
    }

    /// Issue #576: team 単位の同時 recruit permit を取得する。
    ///
    /// `team_id` 単位で初回呼び出し時に lazy 初期化される `tokio::sync::Semaphore` から
    /// `acquire_owned()` で permit を要求する。permit は `OwnedSemaphorePermit` の Drop で
    /// 自動解放されるため、`team_recruit` / `team_create_leader` 側では
    /// `let _permit = hub.acquire_recruit_permit(...).await?;` で関数末尾まで束ねれば、
    /// 正常終了 / `?` での早期 return / panic / future cancel いずれでも自動で解放される。
    ///
    /// permit 数は `VIBE_TEAM_RECRUIT_CONCURRENCY` 環境変数で `1..=RECRUIT_MAX_CONCURRENCY`
    /// の範囲に上書きできる (範囲外 / parse 失敗時は `RECRUIT_DEFAULT_CONCURRENCY`)。
    /// 値は `team_id` ごとの初回 acquire 時に確定し、その後の env 変更では再評価しない
    /// (= 起動時にのみ調整する想定)。
    ///
    /// permit 取得待ちが長引いて caller (MCP client) が timeout するのを避けるため、
    /// 既存 `RECRUIT_TIMEOUT` (30s) と同水準の上限を取得側にも入れている。
    ///
    /// 戻り値の `Err(String)` は **人間可読メッセージのみ** を含む (= `"recruit_permit_timeout"`
    /// 等の error code prefix は付けない)。caller 側で `RecruitError::new("recruit_permit_timeout",
    /// msg)` 等でラップして flat JSON `{ "code": ..., "message": ..., "phase": ... }` に
    /// シリアライズする責務を持たせる。これにより renderer が `code` で機械的に分岐する際に
    /// `code` 文字列が `message` に重複混入するのを避ける (PR #583 review より)。
    pub async fn acquire_recruit_permit(
        &self,
        team_id: &str,
    ) -> Result<OwnedSemaphorePermit, String> {
        // semaphore の lookup / 挿入だけ HubState lock 内で済ませ、その後の `acquire_owned`
        // はロック外で行う (acquire 側で他の HubState 操作と競合しないように)。
        //
        // Issue #589: lazy init で 1 回だけ tracing log を出す。env を変えたのに反映されない
        // 相談時に、起動ログから実際の permit 数を確認できるようにする。
        // - 範囲内 env override → info "source=env"
        // - env 未設定 (= default 採用) → info "source=default"
        // - env 設定済みだが parse 失敗 / 範囲外で default にフォールバック → warn "source=fallback"
        let semaphore = {
            let mut s = self.state.lock().await;
            if let Some(existing) = s.recruit_semaphores.get(team_id) {
                existing.clone()
            } else {
                let (permits, source) = recruit_concurrency_from_env_with_source();
                if matches!(source, RecruitConcurrencySource::InvalidEnvFallback) {
                    tracing::warn!(
                        "[teamhub] recruit semaphore initialized: team={team_id} permits={permits} source={source}",
                        source = source.label(),
                    );
                } else {
                    tracing::info!(
                        "[teamhub] recruit semaphore initialized: team={team_id} permits={permits} source={source}",
                        source = source.label(),
                    );
                }
                let sem = Arc::new(Semaphore::new(permits));
                s.recruit_semaphores
                    .insert(team_id.to_string(), sem.clone());
                sem
            }
        };
        let timeout = crate::team_hub::protocol::consts::RECRUIT_TIMEOUT;
        match tokio::time::timeout(timeout, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => Ok(permit),
            Ok(Err(_closed)) => Err(format!(
                "recruit semaphore for team_id={team_id} was closed"
            )),
            Err(_) => Err(format!(
                "could not acquire a recruit permit for team_id={team_id} within {}s \
                 (concurrency saturated)",
                timeout.as_secs()
            )),
        }
    }

    /// テスト専用: 指定 `team_id` の recruit semaphore を任意の permit 数で初期化 (or 置換)。
    /// `acquire_recruit_permit` の lazy init をスキップして permit 数を直接指定したいときに使う。
    #[cfg(test)]
    pub(crate) async fn set_recruit_concurrency_for_test(&self, team_id: &str, permits: usize) {
        let mut s = self.state.lock().await;
        s.recruit_semaphores
            .insert(team_id.to_string(), Arc::new(Semaphore::new(permits)));
    }

    /// Issue #342 Phase 1: renderer 側 `app_recruit_ack` invoke の核ロジック。
    ///
    /// 認可ガード (3 重防御):
    ///   1. **pending エントリ存在確認**: `pending_recruits.get(agent_id)` が None なら no-op + warn
    ///   2. **team_id 一致確認**: pending の `team_id != expected_team_id` なら no-op + warn
    ///      (cross-team から偽の cancel を仕込めないようにする)
    ///   3. **重複 ack 弾き**: `ack_done.compare_exchange(false, true, ...)` で 2 回目以降を no-op 化
    ///
    /// `ok=true` を受け取っても **MCP `team_recruit` の戻り値はまだ成功にしない**。
    /// 真の成功判定は `resolve_pending_recruit` (handshake 経由) のみ。renderer 信頼境界違反で
    /// 偽 `ok=true` を打たれても MCP caller は騙されない。
    pub async fn resolve_recruit_ack(
        &self,
        agent_id: &str,
        expected_team_id: &str,
        outcome: RecruitAckOutcome,
    ) -> Result<(), AckError> {
        let mut s = self.state.lock().await;
        let Some(pending) = s.pending_recruits.get_mut(agent_id) else {
            // Issue #574: ack_timeout 後の遅着 ack は設計上の正常現象 (cancel_pending_recruit が
            // pending を完全削除した後で renderer が ack invoke を届けるパス) なので、
            // warn → info に降格してアラート noise を減らす。agent_id / team_id / reason は
            // 構造化キーで出して grep / 集計しやすくする。
            tracing::info!(
                "[teamhub] recruit_ack ignored agent_id={agent_id} team_id={expected_team_id} \
                 reason=no_pending_recruit"
            );
            return Err(AckError::NotFound);
        };
        if pending.team_id != expected_team_id {
            tracing::warn!(
                "[teamhub] recruit_ack ignored: team_id mismatch agent={agent_id} \
                 pending_team={} expected_team={expected_team_id} requester={}",
                pending.team_id,
                pending.requester_agent_id
            );
            return Err(AckError::TeamMismatch);
        }
        if pending
            .ack_done
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            tracing::warn!("[teamhub] recruit_ack ignored: already acked agent={agent_id}");
            return Err(AckError::AlreadyAcked);
        }
        if let Some(timed_out_at) = pending.timed_out_at {
            // timeout 後 grace 中の遅着 ack。ack waiter は既に close 済みなので送信せず、
            // renderer 側へ rescue event を出してカード維持を観測可能にする。
            let _ = pending.ack_tx.take();
            let late_by_ms = timed_out_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            let payload = RecruitRescuedPayload {
                new_agent_id: agent_id.to_string(),
                late_by_ms,
            };
            drop(s);
            tracing::info!(
                "[teamhub] recruit_ack rescued agent={} late_by_ms={}",
                agent_id,
                late_by_ms
            );
            self.emit_recruit_rescued(payload).await;
            return Ok(());
        }

        let ack_tx = pending.ack_tx.take();
        // pending エントリ自体は handshake 待機中の `tx` をまだ保持している必要があるため remove しない。
        drop(s);
        if let Some(tx) = ack_tx {
            // 受信側 (team_recruit) が既に drop していても無視 (タイムアウト後の遅延 ack 等)
            let _ = tx.send(outcome);
        }
        Ok(())
    }

    async fn emit_recruit_rescued(&self, payload: RecruitRescuedPayload) {
        #[cfg(test)]
        {
            RECRUIT_RESCUED_EVENTS_FOR_TEST
                .lock()
                .expect("recruit rescued test event mutex poisoned")
                .push(payload.clone());
        }

        let app = self.app_handle.lock().await.clone();
        if let Some(app) = app {
            if let Err(err) = app.emit("team:recruit-rescued", payload) {
                tracing::warn!("[teamhub] failed to emit recruit-rescued event: {err}");
            }
        }
    }
}

/// Issue #589: `recruit_concurrency_from_env_with_source` の戻り値。permit 数の選択経路を
/// 区別して、lazy init 時のログレベル (info / warn) を切り替えるために使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecruitConcurrencySource {
    /// `VIBE_TEAM_RECRUIT_CONCURRENCY` が `1..=RECRUIT_MAX_CONCURRENCY` の範囲内で設定済み。
    Env,
    /// `VIBE_TEAM_RECRUIT_CONCURRENCY` が未設定 (= 通常運用)。
    Default,
    /// `VIBE_TEAM_RECRUIT_CONCURRENCY` は設定されているが parse 失敗 / 範囲外で
    /// `RECRUIT_DEFAULT_CONCURRENCY` にフォールバックした (= 設定ミスの可能性)。
    InvalidEnvFallback,
}

impl RecruitConcurrencySource {
    fn label(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Default => "default",
            Self::InvalidEnvFallback => "fallback",
        }
    }
}

/// Issue #576 / #589: `VIBE_TEAM_RECRUIT_CONCURRENCY` 環境変数を読んで permit 数を決め、
/// その決定経路 (env override / default / 範囲外 fallback) も併せて返す。
///
/// `1..=RECRUIT_MAX_CONCURRENCY` の範囲外・parse 失敗は `RECRUIT_DEFAULT_CONCURRENCY` に
/// フォールバックし、`InvalidEnvFallback` を返す。未設定は `Default`、範囲内 override は
/// `Env`。lazy init log の info / warn 分岐にこの source を使う (Issue #589)。
///
/// `acquire_recruit_permit` の lazy 初期化時に team_id ごとに 1 度だけ呼ばれる想定なので、
/// env を読むオーバーヘッドは無視できる。
fn recruit_concurrency_from_env_with_source() -> (usize, RecruitConcurrencySource) {
    use crate::team_hub::protocol::consts::{RECRUIT_DEFAULT_CONCURRENCY, RECRUIT_MAX_CONCURRENCY};
    match std::env::var("VIBE_TEAM_RECRUIT_CONCURRENCY") {
        Err(_) => (RECRUIT_DEFAULT_CONCURRENCY, RecruitConcurrencySource::Default),
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return (RECRUIT_DEFAULT_CONCURRENCY, RecruitConcurrencySource::Default);
            }
            match trimmed.parse::<usize>() {
                Ok(n) if (1..=RECRUIT_MAX_CONCURRENCY).contains(&n) => {
                    (n, RecruitConcurrencySource::Env)
                }
                _ => (
                    RECRUIT_DEFAULT_CONCURRENCY,
                    RecruitConcurrencySource::InvalidEnvFallback,
                ),
            }
        }
    }
}

/// Issue #577: timeout 後に遅着 ack を rescue する grace window。
/// `VIBE_TEAM_RECRUIT_GRACE_MS=0` は旧挙動互換、`>10000` / parse 失敗 / 未設定は default。
fn recruit_grace_from_env() -> Duration {
    let ms = std::env::var("VIBE_TEAM_RECRUIT_GRACE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|&n| n <= RECRUIT_GRACE_MAX_MS)
        .unwrap_or(RECRUIT_GRACE_DEFAULT_MS);
    Duration::from_millis(ms)
}

/// Issue #742 (Security): recruit grant の TTL。`HANDSHAKE_GRANT_TTL_DEFAULT_MS` 既定。
/// `VIBE_TEAM_HANDSHAKE_TTL_MS` で上書き可能だが、`1..=HANDSHAKE_GRANT_TTL_MAX_MS` の範囲外
/// (= 0 で実質即時失効 / 上限超で TTL 無効化) や parse 失敗時は既定値に丸める。
pub(crate) fn handshake_grant_ttl_from_env() -> Duration {
    let ms = std::env::var("VIBE_TEAM_HANDSHAKE_TTL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|&n| (1..=HANDSHAKE_GRANT_TTL_MAX_MS).contains(&n))
        .unwrap_or(HANDSHAKE_GRANT_TTL_DEFAULT_MS);
    Duration::from_millis(ms)
}

/// Issue #637: `agent_role_bindings` の `(team_id, agent_id)` 複合キー化を検証する単体テスト。
/// cross-team で同 agent_id が違う role で bind しても old team の binding が保持されること、
/// dismiss で当該 (team_id, agent_id) のみ消えて other team の binding が残ることを検証する。
#[cfg(test)]
mod role_binding_team_id_tests {
    use crate::pty::SessionRegistry;
    use crate::team_hub::TeamHub;
    use std::sync::Arc;

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// Issue #742: handshake は「Hub が事前発行した recruit grant」を要求するようになったため、
    /// 初回 handshake をシミュレートするテストは事前に pending grant を登録する。
    /// `team_recruit` / `team_create_leader` が裏で行う `try_register_pending_recruit` の最小版。
    async fn seed_pending(hub: &TeamHub, agent_id: &str, team_id: &str, role: &str) {
        hub.try_register_pending_recruit(
            agent_id.to_string(),
            team_id.to_string(),
            role.to_string(),
            "leader-seed".to_string(),
            false,
            &[],
        )
        .await
        .expect("seed pending recruit should succeed");
    }

    /// 同じ `agent_id` を 2 つの team でそれぞれ違う role として handshake させても、
    /// 各 team の binding は独立に保持される (= cross-team での role 上書きが起きない)。
    #[tokio::test]
    async fn cross_team_same_agent_id_does_not_overwrite_role_binding() {
        let hub = make_hub();
        // team-a で programmer として handshake
        seed_pending(&hub, "agent-1", "team-a", "programmer").await;
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-a", "programmer")
                .await,
            "first handshake on team-a should succeed"
        );
        // team-b で同 agent_id を reviewer として handshake
        seed_pending(&hub, "agent-1", "team-b", "reviewer").await;
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-b", "reviewer")
                .await,
            "handshake of same agent_id on a different team should succeed (different binding key)"
        );
        let s = hub.state.lock().await;
        assert_eq!(
            s.agent_role_bindings
                .get(&("team-a".to_string(), "agent-1".to_string())),
            Some(&"programmer".to_string()),
            "team-a binding should keep its original role even after team-b handshake"
        );
        assert_eq!(
            s.agent_role_bindings
                .get(&("team-b".to_string(), "agent-1".to_string())),
            Some(&"reviewer".to_string()),
            "team-b binding should hold the role asserted on team-b handshake"
        );
    }

    /// 同じ team で同 agent_id が違う role で再 handshake してきた場合は
    /// (issue #183 の挙動どおり) false で拒否される。
    #[tokio::test]
    async fn same_team_role_mismatch_on_rehandshake_is_rejected() {
        let hub = make_hub();
        seed_pending(&hub, "agent-1", "team-a", "programmer").await;
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-a", "programmer")
                .await
        );
        // 2 回目は binding 経由 (Issue #742 の grant は single-use で消費済み) で role 不一致を検出する。
        assert!(
            !hub.resolve_pending_recruit("agent-1", "team-a", "reviewer")
                .await,
            "rehandshake on same team with conflicting role must be rejected"
        );
    }

    /// `remove_agent_role_binding` は当該 `(team_id, agent_id)` のみ消し、
    /// 別 team の同 agent_id の binding は残す。
    #[tokio::test]
    async fn remove_agent_role_binding_only_targets_specified_team_scope() {
        let hub = make_hub();
        seed_pending(&hub, "agent-1", "team-a", "programmer").await;
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-a", "programmer")
                .await
        );
        seed_pending(&hub, "agent-1", "team-b", "reviewer").await;
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-b", "reviewer")
                .await
        );
        let removed = hub.remove_agent_role_binding("team-a", "agent-1").await;
        assert!(removed, "remove should report true when entry existed");

        let s = hub.state.lock().await;
        assert!(
            !s.agent_role_bindings
                .contains_key(&("team-a".to_string(), "agent-1".to_string())),
            "team-a binding should be removed"
        );
        assert_eq!(
            s.agent_role_bindings
                .get(&("team-b".to_string(), "agent-1".to_string())),
            Some(&"reviewer".to_string()),
            "team-b binding for the same agent_id must remain intact"
        );
    }

    /// 存在しない `(team_id, agent_id)` の remove は false を返す (idempotent)。
    #[tokio::test]
    async fn remove_agent_role_binding_returns_false_when_absent() {
        let hub = make_hub();
        let removed = hub
            .remove_agent_role_binding("nonexistent-team", "ghost-agent")
            .await;
        assert!(
            !removed,
            "removing a nonexistent binding should report false without panicking"
        );
    }
}

/// Issue #577: timeout 後 grace 期間中の recruit ack rescue の単体テスト。
#[cfg(test)]
mod recruit_rescue_tests {
    use super::{RecruitAckOutcome, RECRUIT_RESCUED_EVENTS_FOR_TEST};
    use crate::pty::SessionRegistry;
    use crate::team_hub::error::AckError;
    use crate::team_hub::TeamHub;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::Barrier;
    use tokio::time::sleep;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    fn ok_ack() -> RecruitAckOutcome {
        RecruitAckOutcome {
            ok: true,
            reason: None,
            phase: None,
        }
    }

    async fn register(hub: &TeamHub, agent_id: &str) -> super::PendingRecruitChannels {
        hub.try_register_pending_recruit(
            agent_id.to_string(),
            "team-a".to_string(),
            "worker".to_string(),
            "leader-a".to_string(),
            false,
            &[],
        )
        .await
        .expect("pending recruit should be registered")
    }

    fn clear_rescue_events() {
        RECRUIT_RESCUED_EVENTS_FOR_TEST
            .lock()
            .expect("recruit rescued test event mutex poisoned")
            .clear();
    }

    fn rescue_events() -> Vec<super::RecruitRescuedPayload> {
        RECRUIT_RESCUED_EVENTS_FOR_TEST
            .lock()
            .expect("recruit rescued test event mutex poisoned")
            .clone()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn timed_out_ack_within_grace_is_rescued_and_emits_event() {
        let _env_guard = ENV_LOCK.lock().expect("env lock poisoned");
        std::env::set_var("VIBE_TEAM_RECRUIT_GRACE_MS", "2000");
        clear_rescue_events();

        let hub = make_hub();
        let channels = register(&hub, "agent-rescue").await;

        hub.cancel_pending_recruit("agent-rescue").await;
        assert!(
            channels.ack.await.is_err(),
            "ack waiter should be closed immediately at timeout"
        );

        sleep(Duration::from_millis(20)).await;
        hub.resolve_recruit_ack("agent-rescue", "team-a", ok_ack())
            .await
            .expect("late ack within grace should be rescued");

        let events = rescue_events();
        assert_eq!(events.len(), 1, "rescue event should be recorded once");
        assert_eq!(events[0].new_agent_id, "agent-rescue");
        assert!(
            events[0].late_by_ms > 0,
            "late_by_ms should record elapsed time after timeout"
        );

        let timed_out = hub
            .state
            .lock()
            .await
            .pending_recruits
            .get("agent-rescue")
            .and_then(|p| p.timed_out_at)
            .is_some();
        assert!(timed_out, "pending should remain during grace window");

        std::env::remove_var("VIBE_TEAM_RECRUIT_GRACE_MS");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn grace_zero_removes_pending_immediately_and_late_ack_is_not_found() {
        let _env_guard = ENV_LOCK.lock().expect("env lock poisoned");
        std::env::set_var("VIBE_TEAM_RECRUIT_GRACE_MS", "0");
        clear_rescue_events();

        let hub = make_hub();
        let channels = register(&hub, "agent-zero").await;

        hub.cancel_pending_recruit("agent-zero").await;
        assert!(
            channels.ack.await.is_err(),
            "ack waiter should be closed immediately"
        );
        assert!(
            !hub.state
                .lock()
                .await
                .pending_recruits
                .contains_key("agent-zero"),
            "grace=0 should preserve the old immediate-remove behavior"
        );

        let err = hub
            .resolve_recruit_ack("agent-zero", "team-a", ok_ack())
            .await
            .expect_err("late ack after immediate removal should be rejected");
        assert!(matches!(err, AckError::NotFound));
        assert!(rescue_events().is_empty());

        std::env::remove_var("VIBE_TEAM_RECRUIT_GRACE_MS");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancel_and_duplicate_ack_race_is_serialized_by_ack_done() {
        clear_rescue_events();

        let hub = make_hub();
        let _channels = register(&hub, "agent-race").await;
        let barrier = Arc::new(Barrier::new(3));

        let cancel_hub = hub.clone();
        let cancel_barrier = barrier.clone();
        let cancel_task = tokio::spawn(async move {
            cancel_barrier.wait().await;
            cancel_hub
                .cancel_pending_recruit_with_grace("agent-race", Duration::from_millis(2000))
                .await;
        });

        let ack_hub_1 = hub.clone();
        let ack_barrier_1 = barrier.clone();
        let ack_task_1 = tokio::spawn(async move {
            ack_barrier_1.wait().await;
            ack_hub_1
                .resolve_recruit_ack("agent-race", "team-a", ok_ack())
                .await
        });

        let ack_hub_2 = hub.clone();
        let ack_barrier_2 = barrier.clone();
        let ack_task_2 = tokio::spawn(async move {
            ack_barrier_2.wait().await;
            ack_hub_2
                .resolve_recruit_ack("agent-race", "team-a", ok_ack())
                .await
        });

        cancel_task.await.expect("cancel task should not panic");
        let ack_results = [
            ack_task_1.await.expect("ack task 1 should not panic"),
            ack_task_2.await.expect("ack task 2 should not panic"),
        ];

        let ok_count = ack_results.iter().filter(|r| r.is_ok()).count();
        let already_acked_count = ack_results
            .iter()
            .filter(|r| matches!(r, Err(AckError::AlreadyAcked)))
            .count();
        assert_eq!(ok_count, 1, "exactly one ack should win the race");
        assert_eq!(
            already_acked_count, 1,
            "the losing duplicate ack should be rejected by compare_exchange"
        );
        assert!(
            rescue_events().len() <= 1,
            "at most one rescue event should be emitted"
        );
    }
}

/// Issue #576: `acquire_recruit_permit` / `recruit_semaphores` の単体テスト。
///
/// `team_recruit` 全体は renderer (app_handle) 依存なのでここでは結合せず、permit ヘルパ
/// 単独の挙動 — (a) permit=1 で並列 acquire が直列化される、(b) panic / cancel で permit
/// が解放される、(c) 異なる team_id は独立に並列実行できる — を確認する。
#[cfg(test)]
mod recruit_semaphore_tests {
    use crate::pty::SessionRegistry;
    use crate::team_hub::TeamHub;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::time::{sleep, timeout};

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// permit=1 のとき、2 件目の acquire は 1 件目の permit が drop されるまで待つ
    /// (= 同一 team_id の同時 recruit が直列化される)。
    #[tokio::test]
    async fn permit_one_serializes_two_concurrent_acquires() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-a", 1).await;

        let permit_a = hub
            .acquire_recruit_permit("team-a")
            .await
            .expect("first acquire should succeed");

        let hub_for_task = hub.clone();
        let handle =
            tokio::spawn(async move { hub_for_task.acquire_recruit_permit("team-a").await });

        // permit_a を握ったまま十分に待つ。直列化されているなら handle は完了しない。
        sleep(Duration::from_millis(150)).await;
        assert!(
            !handle.is_finished(),
            "second acquire must remain pending while first permit is held"
        );

        drop(permit_a);

        let permit_b = timeout(Duration::from_secs(2), handle)
            .await
            .expect("second acquire should complete shortly after first permit drop")
            .expect("spawned task must not panic")
            .expect("second acquire should succeed");
        drop(permit_b);
    }

    /// permit を保持した task が panic で死んでも、`OwnedSemaphorePermit` の Drop で
    /// 解放されるので後続の acquire は即座に成功する。
    #[tokio::test]
    async fn permit_released_when_holder_panics() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-b", 1).await;

        let hub_for_task = hub.clone();
        let handle = tokio::spawn(async move {
            let _permit = hub_for_task
                .acquire_recruit_permit("team-b")
                .await
                .expect("inner acquire should succeed");
            panic!("intentional panic to verify permit drop releases the semaphore");
        });

        let join_result = handle.await;
        assert!(
            join_result.is_err() && join_result.err().is_some_and(|e| e.is_panic()),
            "spawned task should have panicked"
        );

        let permit = timeout(Duration::from_secs(1), hub.acquire_recruit_permit("team-b"))
            .await
            .expect("acquire should not time out after holder panic")
            .expect("acquire should succeed once panicked permit is dropped");
        drop(permit);
    }

    /// permit を保持した task の Future を `abort()` (= cancel) しても、Drop で permit が
    /// 解放されるので後続の acquire は即座に成功する。
    #[tokio::test]
    async fn permit_released_when_holder_future_cancelled() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-c", 1).await;

        let hub_for_task = hub.clone();
        let handle = tokio::spawn(async move {
            let _permit = hub_for_task
                .acquire_recruit_permit("team-c")
                .await
                .expect("inner acquire should succeed");
            // permit を握ったまま長時間 sleep — abort() で future ごと drop される想定。
            sleep(Duration::from_secs(60)).await;
        });

        // permit が確実に握られるまで少しだけ待つ。
        sleep(Duration::from_millis(50)).await;
        handle.abort();
        let _ = handle.await;

        let permit = timeout(Duration::from_secs(1), hub.acquire_recruit_permit("team-c"))
            .await
            .expect("acquire should not time out after holder cancel")
            .expect("acquire should succeed once cancelled permit is dropped");
        drop(permit);
    }

    /// 異なる team_id は別々の Semaphore を持つので、permit=1 でも cross-team では
    /// 並列に acquire できる (= 無関係の team が待たされない)。
    #[tokio::test]
    async fn different_team_ids_are_independent() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-x", 1).await;
        hub.set_recruit_concurrency_for_test("team-y", 1).await;

        let permit_x = hub
            .acquire_recruit_permit("team-x")
            .await
            .expect("team-x acquire should succeed");

        // team-x の permit を握ったままでも、team-y は即座に取れる。
        let permit_y = timeout(Duration::from_secs(1), hub.acquire_recruit_permit("team-y"))
            .await
            .expect("team-y acquire should not be blocked by team-x")
            .expect("team-y acquire should succeed");

        drop(permit_y);
        drop(permit_x);
    }
}

/// Issue #589: `acquire_recruit_permit` の lazy init 時に出力する tracing ログのテスト。
///
/// `tracing::subscriber::with_default` は thread-local で subscriber を差し替えるため、
/// `current_thread` runtime で `block_on` した async コードからも捕捉できる。env を触る
/// テストはプロセス global な VIBE_TEAM_RECRUIT_CONCURRENCY を共有するので Mutex で直列化。
#[cfg(test)]
mod recruit_semaphore_log_tests {
    use crate::pty::SessionRegistry;
    use crate::team_hub::TeamHub;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    #[derive(Clone, Default)]
    struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for CapturedWriter {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn capture<F: FnOnce()>(f: F) -> String {
        let writer = CapturedWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(writer.clone())
            .with_max_level(tracing::Level::TRACE)
            .with_target(false)
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let buf = writer.0.lock().unwrap().clone();
        String::from_utf8(buf).unwrap_or_default()
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build current_thread runtime")
            .block_on(future)
    }

    /// 初回の `acquire_recruit_permit` で 1 回だけ `recruit semaphore initialized` が
    /// 出力され、2 回目以降の acquire では再出力されない (lazy init 1 回限り)。
    #[test]
    fn lazy_init_log_emitted_only_once_per_team() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p1 = hub
                    .acquire_recruit_permit("team-init-once")
                    .await
                    .expect("first acquire should succeed");
                drop(p1);
                let p2 = hub
                    .acquire_recruit_permit("team-init-once")
                    .await
                    .expect("second acquire should succeed");
                drop(p2);
            });
        });

        let init_count = logs.matches("recruit semaphore initialized").count();
        assert_eq!(
            init_count, 1,
            "expected exactly 1 init log across 2 acquires; got: {logs}",
        );
        assert!(
            logs.contains("team=team-init-once"),
            "init log should include team_id; got: {logs}",
        );
        assert!(
            logs.contains("source=default"),
            "unset env should be logged as source=default; got: {logs}",
        );
        assert!(
            logs.contains("INFO"),
            "default source should be info-level; got: {logs}",
        );
    }

    /// 範囲内 env override (`VIBE_TEAM_RECRUIT_CONCURRENCY=4`) は info で `source=env`。
    #[test]
    fn lazy_init_log_with_valid_env_uses_info_and_marks_env() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("VIBE_TEAM_RECRUIT_CONCURRENCY", "4");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p = hub
                    .acquire_recruit_permit("team-init-env")
                    .await
                    .expect("acquire should succeed");
                drop(p);
            });
        });

        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        assert!(
            logs.contains("recruit semaphore initialized"),
            "expected init log; got: {logs}",
        );
        assert!(
            logs.contains("source=env"),
            "in-range env should be logged as source=env; got: {logs}",
        );
        assert!(
            logs.contains("permits=4"),
            "permits should reflect env value; got: {logs}",
        );
        assert!(
            logs.contains("INFO"),
            "valid env should be info-level; got: {logs}",
        );
    }

    /// 範囲外 env (= `VIBE_TEAM_RECRUIT_CONCURRENCY=999`) は warn で `source=fallback`。
    #[test]
    fn lazy_init_log_with_invalid_env_uses_warn_and_marks_fallback() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("VIBE_TEAM_RECRUIT_CONCURRENCY", "999");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p = hub
                    .acquire_recruit_permit("team-init-bad")
                    .await
                    .expect("acquire should still succeed (default fallback)");
                drop(p);
            });
        });

        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        assert!(
            logs.contains("recruit semaphore initialized"),
            "expected init log; got: {logs}",
        );
        assert!(
            logs.contains("source=fallback"),
            "out-of-range env should be logged as source=fallback; got: {logs}",
        );
        assert!(
            logs.contains("WARN"),
            "out-of-range env should be warn-level; got: {logs}",
        );
    }

    /// parse 失敗 (= `VIBE_TEAM_RECRUIT_CONCURRENCY=not-a-number`) も warn + fallback。
    #[test]
    fn lazy_init_log_with_unparseable_env_uses_warn_and_marks_fallback() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("VIBE_TEAM_RECRUIT_CONCURRENCY", "not-a-number");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p = hub
                    .acquire_recruit_permit("team-init-garbage")
                    .await
                    .expect("acquire should still succeed (default fallback)");
                drop(p);
            });
        });

        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        assert!(
            logs.contains("source=fallback"),
            "unparseable env should be logged as source=fallback; got: {logs}",
        );
        assert!(
            logs.contains("WARN"),
            "unparseable env should be warn-level; got: {logs}",
        );
    }
}
