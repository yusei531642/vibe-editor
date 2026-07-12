//! Issue #739 / #1077: Codex 初手プロンプトの PTY 注入経路。
//! terminal.rs の file-size ratchet (Issue #939) に伴い自己完結モジュールとして分離。

use crate::team_hub::inject::build_chunks;
use std::sync::Arc;
use std::time::Duration;

/// Issue #739: `inject_codex_prompt_to_pty` が PTY 注入を始める前に待つ初期スリープ (ミリ秒)。
///
/// Codex の TUI が起動してから prompt 入力を受け付ける状態になるまでの猶予。旧実装は
/// `sleep(Duration::from_millis(1800))` の magic number 直書きだった。短すぎると注入文字が
/// TUI 初期化中に取りこぼされ、長すぎると初手の指示が遅れて UX が悪化するため、この 1 箇所で
/// 調整できるよう定数化する。
const CODEX_INITIAL_PROMPT_DELAY_MS: u64 = 1800;

/// Issue #739: `inject_codex_prompt_to_pty` のチャンク間 / 末尾 `\r` 送出前スリープ (ミリ秒)。
///
/// ConPTY のリングバッファ事故を避けつつ Codex TUI が paste sequence を 1 件として
/// バンドルできる時間的余裕を確保するための値。`team_hub::protocol::consts::INJECT_CHUNK_DELAY_MS`
/// と意図的に同値だが、当該定数は `pub(in crate::team_hub)` で `commands` から不可視のため、
/// terminal 側のチャンク注入用にローカル定数として持つ (旧実装は `15` の直書きだった)。
const CODEX_PROMPT_CHUNK_DELAY_MS: u64 = 15;

/// Issue #1077: codex 初手プロンプト注入の末尾確定 `\r` を送る試行回数 (初回 + retry)。
///
/// 本文 (bracketed paste) は届いたのに最終 `\r` だけ失敗すると、codex TUI は入力欄に
/// 貼られた表示のまま confirm されず「起動したのに何も始まらない」状態になる。ConPTY
/// back-pressure 等で `\r` が一過性に失敗するケースに備え、確定 write を最大この回数まで
/// 再試行する (team_hub の inject は #378 で最終 `\r` 失敗を `FinalCrFailed` として伝播
/// 済みだが、本経路は fire-and-forget task のため retry で復旧を図る)。
const CODEX_FINAL_CR_MAX_ATTEMPTS: u32 = 3;

/// Issue #1077: 末尾確定 `\r` の retry 間に挟むスリープ (ミリ秒)。
///
/// back-pressure が解ける猶予を与えてから再送するための短い待ち。
const CODEX_FINAL_CR_RETRY_DELAY_MS: u64 = 30;

/// Issue #1077: codex 初手プロンプトの確定 `\r` 送出 retry の最終結果。
///
/// session 消滅由来の打ち切りと「全試行が write 失敗で尽きた」を区別し、ログの文言と
/// レベルを出し分けるために使う (code review M1)。
#[derive(Debug, PartialEq, Eq)]
enum FinalCrOutcome {
    /// `\r` write が確定した (成功)。
    Confirmed,
    /// retry 途中で session が消えた (codex は既に exit 済みの可能性) → 確定待ちではない。
    SessionGone,
    /// 全試行が write 失敗で尽きた → codex が確定待ちのまま固まる恐れ。
    Exhausted,
}

/// Issue #1077: 確定 `\r` を最大 `max_attempts` 回試行する汎用 retry ループ。
///
/// `spawn_blocking` / 実 PTY 依存を `write_cr` / `session_alive` の closure 境界の外に出す
/// ことで、試行回数・retry 打ち切り条件・session 消滅検知をユニットテスト可能にする。
///
/// - `write_cr(attempt)`: 1 回分の `\r` write を行う。`true` で確定成功。失敗時の warn ログは
///   呼び出し側 closure 内で出す。
/// - `session_alive()`: retry sleep に入る前に session がまだ生きているか確認する。生きて
///   いなければ SessionGone で即打ち切る。
async fn write_final_cr_with_retry<WFut, W, A>(
    max_attempts: u32,
    retry_delay: Duration,
    mut write_cr: W,
    mut session_alive: A,
) -> FinalCrOutcome
where
    W: FnMut(u32) -> WFut,
    WFut: std::future::Future<Output = bool>,
    A: FnMut() -> bool,
{
    for attempt in 1..=max_attempts {
        if write_cr(attempt).await {
            return FinalCrOutcome::Confirmed;
        }
        if attempt < max_attempts {
            // session がもう無ければ再送しても無駄。codex は確定前に exit 済みと判断して打ち切る。
            if !session_alive() {
                return FinalCrOutcome::SessionGone;
            }
            tokio::time::sleep(retry_delay).await;
        }
    }
    FinalCrOutcome::Exhausted
}

/// Codex の system prompt を、PTY (TUI) に直接「最初の入力」として注入する fallback 経路。
///
/// 動作:
///   1. spawn 直後 1.8 秒スリープして Codex の TUI が prompt 入力を受け付ける状態になるのを待つ。
///   2. team_hub::inject::build_chunks で ConPTY-safe チャンク (64B / 15ms / UTF-8 境界保護) に
///      整形 (banner は空文字)。
///   3. 各チャンクを順に書き込み、最後に \r で確定送信。
///
/// チームメッセージの inject() と違って banner は付けない (Codex に対する初手のユーザー指示として届く)。
///
/// Issue #620: `SessionHandle::write` は内部で `std::sync::Mutex::lock` + 同期 `write_all`/`flush`
/// なので、tokio multi-thread runtime の async task 内から直接呼ぶと ConPTY back-pressure 時に
/// worker thread を 1 本占有してしまう。`team_hub::inject::inject_once` と同じく
/// `tokio::task::spawn_blocking` で blocking pool に逃がし、async runtime を解放する。
pub(super) async fn inject_codex_prompt_to_pty(
    registry: Arc<crate::pty::SessionRegistry>,
    term_id: String,
    instructions: String,
) {
    use tokio::time::sleep;
    sleep(Duration::from_millis(CODEX_INITIAL_PROMPT_DELAY_MS)).await;
    let Some(session) = registry.get(&term_id) else {
        return;
    };
    // Issue #153 / #619: 注入中はユーザーの xterm 入力 (terminal_write) を抑止する。
    // RAII guard (`begin_injecting`) を使うことで、関数を抜けるあらゆる経路 (early return /
    // panic / `?` 伝播 / 正常終了) で `injecting` フラグが必ず false に戻る。
    // build_chunks は banner 込みで分割するが、Codex 注入では banner 不要なので空文字を渡す。
    let _inject_guard = session.begin_injecting();
    let chunks = build_chunks("", &instructions);
    if chunks.is_empty() {
        return;
    }
    let mut iter = chunks.into_iter();
    if let Some(first) = iter.next() {
        // Issue #620: spawn_blocking で同期 write を blocking pool に逃がす。
        // Issue #619: 早期 return しても `_inject_guard` の Drop で injecting=false に戻る。
        let s = session.clone();
        match tokio::task::spawn_blocking(move || s.write(&first)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(
                    "[terminal] codex prompt write(first) failed for {term_id}: {e}"
                );
                return;
            }
            Err(e) => {
                tracing::warn!(
                    "[terminal] codex prompt spawn_blocking(first) failed for {term_id}: {e}"
                );
                return;
            }
        }
    }
    for chunk in iter {
        sleep(Duration::from_millis(CODEX_PROMPT_CHUNK_DELAY_MS)).await;
        if registry.get(&term_id).is_none() {
            return;
        }
        // Issue #620: 各チャンクの write も spawn_blocking 経由。
        // Issue #619: 早期 return / panic でも guard Drop が injecting=false に戻す。
        let s = session.clone();
        match tokio::task::spawn_blocking(move || s.write(&chunk)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(
                    "[terminal] codex prompt write(chunk) failed for {term_id}: {e}"
                );
                return;
            }
            Err(e) => {
                tracing::warn!(
                    "[terminal] codex prompt spawn_blocking(chunk) failed for {term_id}: {e}"
                );
                return;
            }
        }
    }
    sleep(Duration::from_millis(CODEX_PROMPT_CHUNK_DELAY_MS)).await;
    // Issue #620: 末尾の確定 `\r` も spawn_blocking 経由で送る。
    // Issue #1077: 旧実装は `\r` 失敗を warn のみで握り潰しており、本文 paste は届いたのに
    // Enter 未確定で codex が起動指示を実行しないまま待機する事故 (「起動したのに何も
    // 始まらない」) を招いていた。ConPTY back-pressure 等の一過性失敗に備え、確定 `\r` を
    // write_final_cr_with_retry で最大 CODEX_FINAL_CR_MAX_ATTEMPTS 回まで再試行する。
    let outcome = write_final_cr_with_retry(
        CODEX_FINAL_CR_MAX_ATTEMPTS,
        Duration::from_millis(CODEX_FINAL_CR_RETRY_DELAY_MS),
        |attempt| {
            let s = session.clone();
            let term_id = term_id.clone();
            async move {
                match tokio::task::spawn_blocking(move || s.write(b"\r")).await {
                    Ok(Ok(())) => true,
                    Ok(Err(e)) => {
                        tracing::warn!(
                            "[terminal] codex prompt write(\\r) attempt {attempt}/{CODEX_FINAL_CR_MAX_ATTEMPTS} failed for {term_id}: {e}"
                        );
                        false
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[terminal] codex prompt spawn_blocking(\\r) attempt {attempt}/{CODEX_FINAL_CR_MAX_ATTEMPTS} failed for {term_id}: {e}"
                        );
                        false
                    }
                }
            }
        },
        || registry.get(&term_id).is_some(),
    )
    .await;
    match outcome {
        FinalCrOutcome::Confirmed => {}
        FinalCrOutcome::SessionGone => {
            // session が消えている = codex は確定前に既に exit 済み。確定待ちではないので
            // warn 止まり (「unconfirmed で固まっている」誤解を生む error を出さない)。
            tracing::warn!(
                "[terminal] codex prompt final \\r aborted for {term_id} — session already gone (codex likely exited before confirm)"
            );
        }
        FinalCrOutcome::Exhausted => {
            // 全試行が write 失敗で尽きた。codex は確定待ちのまま固まる可能性が高い。
            tracing::error!(
                "[terminal] codex prompt final \\r never confirmed for {term_id} after {CODEX_FINAL_CR_MAX_ATTEMPTS} attempts — codex may be waiting unconfirmed"
            );
        }
    }
    tracing::info!(
        "[terminal] codex prompt injected into pty {term_id} ({} bytes)",
        instructions.len()
    );
}


#[cfg(test)]
mod final_cr_retry_tests {
    use super::{write_final_cr_with_retry, FinalCrOutcome};
    use std::cell::Cell;
    use std::time::Duration;

    // retry delay は 0 にして、テストが実時間 sleep しないようにする。
    const NO_DELAY: Duration = Duration::from_millis(0);

    #[tokio::test]
    async fn confirmed_on_first_attempt() {
        let calls = Cell::new(0u32);
        let outcome = write_final_cr_with_retry(
            3,
            NO_DELAY,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { true }
            },
            || true,
        )
        .await;
        assert_eq!(outcome, FinalCrOutcome::Confirmed);
        assert_eq!(calls.get(), 1, "成功すれば 1 回で打ち切るはず");
    }

    #[tokio::test]
    async fn confirmed_after_transient_failures() {
        // Issue #1077 の本命: 最初の 2 回失敗 → 3 回目で確定。
        let calls = Cell::new(0u32);
        let outcome = write_final_cr_with_retry(
            3,
            NO_DELAY,
            |attempt| {
                calls.set(calls.get() + 1);
                async move { attempt == 3 }
            },
            || true,
        )
        .await;
        assert_eq!(outcome, FinalCrOutcome::Confirmed);
        assert_eq!(calls.get(), 3, "3 回目で成功するまで retry するはず");
    }

    #[tokio::test]
    async fn exhausted_when_all_attempts_fail() {
        let calls = Cell::new(0u32);
        let outcome = write_final_cr_with_retry(
            3,
            NO_DELAY,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { false }
            },
            || true, // session は生存し続ける
        )
        .await;
        assert_eq!(outcome, FinalCrOutcome::Exhausted);
        assert_eq!(calls.get(), 3, "max_attempts ぶん試行して尽きるはず");
    }

    #[tokio::test]
    async fn aborts_when_session_gone() {
        // session 消滅時は retry せず即 SessionGone (Exhausted の error 文言を出さない / M1)。
        let calls = Cell::new(0u32);
        let outcome = write_final_cr_with_retry(
            3,
            NO_DELAY,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { false }
            },
            || false, // 1 回目失敗後の生存確認で「消滅」を返す
        )
        .await;
        assert_eq!(outcome, FinalCrOutcome::SessionGone);
        assert_eq!(calls.get(), 1, "session 消滅を検知したら追加 retry しないはず");
    }
}

