//! Issue #738: `SessionHandle::injecting` フラグの RAII guard (`InjectingGuard`)。
//!
//! 旧 `session.rs` から型定義をそのまま切り出したもの。挙動は変えていない。

use std::sync::Arc;

use super::handle::SessionHandle;

/// Issue #619: `SessionHandle::injecting` を「true → false」で必ずペアで操作するための RAII guard。
///
/// `SessionHandle::begin_injecting()` が返す。戻り値を変数に束縛している間 `injecting == true`
/// が維持され、変数のスコープを抜けた時点 (early return / panic / `?` 伝播 / 正常終了) で
/// `Drop` が走って `injecting == false` に必ず戻る。
///
/// 旧実装 (set_injecting(true) / set_injecting(false) を手動でペアで書く) は、
/// `inject_once` のように途中で多数の `?` / 早期 return / panic 経路があるコードでは
/// 1 箇所でも `set_injecting(false)` が抜けると `injecting` が `true` に貼り付き、
/// 以後その PTY のユーザー入力 (terminal_write 経路) が完全に無効化されたままになる
/// 可能性があった (#619 の根本原因の対称ケース)。
///
/// `Arc<SessionHandle>` を保持するのは `inject_once` の async 経路で session が drop されるより前に
/// guard 側で確実に reset したいため (Drop の時点で session が生きていることを保証する)。
pub struct InjectingGuard {
    session: Arc<SessionHandle>,
}

impl InjectingGuard {
    pub(super) fn new(session: Arc<SessionHandle>) -> Self {
        session.set_injecting(true);
        Self { session }
    }
}

impl Drop for InjectingGuard {
    fn drop(&mut self) {
        // panic 経路 / 早期 return 経路 / 正常終了経路すべてで injecting=false に戻す。
        self.session.set_injecting(false);
    }
}
