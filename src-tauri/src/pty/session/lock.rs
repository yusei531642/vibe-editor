//! Issue #738: `SessionHandle` が抱える `std::sync::Mutex` の lock helper。
//!
//! 旧 `session.rs` では `writer` / `master` / `killer` / `write_budget` の 4 つの
//! `Mutex` に対して、ロック取得失敗 (poison) を `anyhow::Error` に変換する
//! `.lock().map_err(|e| anyhow!("<name> lock poisoned: {e}"))?` という同型コードが
//! 4 箇所に重複していた。
//!
//! ここに `LockResult<T>` エイリアスと `lock_poisoned!` macro を切り出し、
//! 重複を 1 つの macro 呼び出しに集約する。挙動 (poison 時に `anyhow::Error` を
//! 返す) は旧コードと同一で、エラーメッセージ書式も `"<name> lock poisoned: {e}"`
//! のまま変えていない。

use std::sync::{MutexGuard, PoisonError};

/// `Mutex::lock()` の生の戻り値型。`PoisonError<MutexGuard<'_, T>>` を保つことで
/// `into_inner()` で recover する `Drop` 経路 (poison しても child kill は試みる)
/// が型レベルで素直に書ける。`lock_poisoned!` macro が扱う「`anyhow` へ落とす前」の型。
pub(super) type LockResult<'a, T> = Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>;

/// `Mutex` を lock し、poison していたら `anyhow::Error` を返す。
///
/// 旧 `session.rs` の
/// ```ignore
/// let mut w = self
///     .writer
///     .lock()
///     .map_err(|e| anyhow!("writer lock poisoned: {e}"))?;
/// ```
/// を `lock_poisoned!(self.writer, "writer")?` の 1 行に置き換える。
/// `$mutex` には `Mutex<T>` への参照式、`$name` には人間可読なロック名を渡す。
///
/// 返り値は `Result<MutexGuard<'_, T>, anyhow::Error>` なので、呼び出し側で
/// そのまま `?` を付ける。エラー文言は旧実装と同じ `"<name> lock poisoned: {e}"`。
macro_rules! lock_poisoned {
    ($mutex:expr, $name:expr) => {
        $mutex
            .lock()
            .map_err(|e| ::anyhow::anyhow!("{} lock poisoned: {}", $name, e))
    };
}

pub(super) use lock_poisoned;
