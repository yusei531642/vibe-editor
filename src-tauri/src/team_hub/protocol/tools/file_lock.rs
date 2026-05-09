//! tools: `team_lock_files` / `team_unlock_files` — vibe-team の advisory file lock。Issue #526。
//!
//! `worker` が `Edit` / `Write` 等で同じファイルを silent overwrite するのを防ぐため、
//! 編集前に `team_lock_files(paths=[...])` で予約、編集後に `team_unlock_files(paths=[...])`
//! で解放する協調的 lock。**advisory** = 取得しなくても hard fail しないが、Leader / 他の
//! worker は `team_assign_task(target_paths=[...])` で peek した結果を見て調整する。
//!
//! response:
//! - `team_lock_files` → `{ locked: string[], conflicts: LockConflict[] }` (partial success)
//! - `team_unlock_files` → `{ unlocked: string[] }`
//!
//! 権限: 全 team member が呼べる (`team_send` / `team_read` 同様、追加権限は不要)。
//! ただし `paths` は最大 64 件 / 1 件あたり 4 KiB に制限する (DoS 抑止)。

use crate::team_hub::file_locks::normalize_path;
use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

use super::error::ToolError;

/// 1 リクエストで指定できる path 数の上限 (DoS 抑止)。
const MAX_LOCK_PATHS_PER_CALL: usize = 64;
/// 1 path あたりの最大バイト長 (異常な巨大 path を弾く)。
const MAX_LOCK_PATH_LEN: usize = 4 * 1024;
/// Issue #599 (Tier A-1): team あたりの advisory lock 表サイズの上限。
/// 正規化後 1 path あたり ~100 byte 想定で 128 件 ≒ 13 KiB / team。
/// この上限で `team_lock_files` を 1024 byte path 64 件で連打されても 64 KiB で頭打ち。
const MAX_LOCKS_PER_TEAM: usize = 128;

/// `raw_path` を audit log に safe に出すための clamp (改行や ESC は normalize_path で reject 済みだが、
/// 念のため 80 文字で切る + 制御文字を `?` 化する defense-in-depth)。
fn clamp_for_log(raw: &str) -> String {
    raw.chars()
        .take(80)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// Issue #599: paths を 1 件ずつ `normalize_path` で validate する。
/// invalid なものが 1 件でもあれば全体を `lock_files_invalid_path` で reject し、
/// `tracing::warn!` で agent_id / team_id / clamp 後の生 path / FileLockError を audit log に残す。
fn validate_and_normalize_paths(
    ctx: &CallContext,
    raw_paths: &[String],
    code_prefix: &str,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(raw_paths.len());
    for raw in raw_paths {
        match normalize_path(raw) {
            Ok(p) => out.push(p),
            Err(e) => {
                tracing::warn!(
                    team_id = %ctx.team_id,
                    agent_id = %ctx.agent_id,
                    role = %ctx.role,
                    raw_path = %clamp_for_log(raw),
                    error = %e,
                    "[{}] invalid path rejected",
                    code_prefix
                );
                return Err(ToolError::new(
                    format!("{code_prefix}_invalid_path"),
                    format!("invalid path '{}': {e}", clamp_for_log(raw)),
                )
                .into_err_string());
            }
        }
    }
    Ok(out)
}

fn parse_paths_arg(args: &Value, code_prefix: &str) -> Result<Vec<String>, String> {
    let arr = args.get("paths").and_then(|v| v.as_array()).ok_or_else(|| {
        ToolError::invalid_args(code_prefix, "`paths` must be a non-empty string array")
            .into_err_string()
    })?;
    if arr.is_empty() {
        return Err(ToolError::invalid_args(code_prefix, "`paths` must be a non-empty string array")
            .into_err_string());
    }
    if arr.len() > MAX_LOCK_PATHS_PER_CALL {
        return Err(ToolError::invalid_args(
            code_prefix,
            format!(
                "too many paths: {} (limit {})",
                arr.len(),
                MAX_LOCK_PATHS_PER_CALL
            ),
        )
        .into_err_string());
    }
    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        let s = v.as_str().ok_or_else(|| {
            ToolError::invalid_args(code_prefix, "`paths` must be an array of strings")
                .into_err_string()
        })?;
        if s.len() > MAX_LOCK_PATH_LEN {
            return Err(ToolError::invalid_args(
                code_prefix,
                format!(
                    "path too long: {} bytes (limit {})",
                    s.len(),
                    MAX_LOCK_PATH_LEN
                ),
            )
            .into_err_string());
        }
        out.push(s.to_string());
    }
    Ok(out)
}

/// `team_lock_files`: paths を advisory に lock する。partial success (一部 conflict でも残りは locked)。
///
/// Issue #599 (Tier A-1): IPC 段で 2 段の validation を行う:
/// 1. `normalize_path` で path 1 件ずつを validate (`..` / 絶対 / 制御文字 / 過大長 を reject)
/// 2. `try_acquire_file_locks_with_cap` で team あたり `MAX_LOCKS_PER_TEAM` の cap を atomic に enforce
pub async fn team_lock_files(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let raw_paths = parse_paths_arg(args, "lock_files")?;
    let paths = validate_and_normalize_paths(ctx, &raw_paths, "lock_files")?;
    let result = match hub
        .try_acquire_file_locks_with_cap(
            &ctx.team_id,
            &ctx.agent_id,
            &ctx.role,
            &paths,
            MAX_LOCKS_PER_TEAM,
        )
        .await
    {
        Ok(r) => r,
        Err(cap_exceeded) => {
            tracing::warn!(
                team_id = %ctx.team_id,
                agent_id = %ctx.agent_id,
                role = %ctx.role,
                current_locks = cap_exceeded.current,
                requested = cap_exceeded.requested,
                limit = cap_exceeded.cap,
                "[team_lock_files] team lock cap exceeded — refusing to add new locks"
            );
            return Err(ToolError::new(
                "lock_files_too_many_locks",
                format!(
                    "team lock cap exceeded: {} existing + {} requested > {} (limit per team)",
                    cap_exceeded.current, cap_exceeded.requested, cap_exceeded.cap,
                ),
            )
            .into_err_string());
        }
    };
    Ok(json!({
        "success": true,
        "locked": result.locked,
        "conflicts": result.conflicts,
    }))
}

/// `team_unlock_files`: 自分が保持する paths のロックを解放。他 agent の lock は silent skip。
///
/// Issue #599: lock 側と同じ validator を通して、`..` や絶対 path を含む release 要求は
/// `unlock_files_invalid_path` で reject する (= 内部 HashMap key の偽装で他者 lock を解除させる
/// 経路を構造的に塞ぐ defense-in-depth)。
pub async fn team_unlock_files(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let raw_paths = parse_paths_arg(args, "unlock_files")?;
    let paths = validate_and_normalize_paths(ctx, &raw_paths, "unlock_files")?;
    let result = hub
        .release_file_locks(&ctx.team_id, &ctx.agent_id, &paths)
        .await;
    Ok(json!({
        "success": true,
        "unlocked": result.unlocked,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_paths_rejects_missing_paths() {
        let args = json!({});
        let err = parse_paths_arg(&args, "lock_files").unwrap_err();
        assert!(err.contains("lock_files_invalid_args"));
        assert!(err.contains("non-empty string array"));
    }

    #[test]
    fn parse_paths_rejects_empty_array() {
        let args = json!({ "paths": [] });
        let err = parse_paths_arg(&args, "lock_files").unwrap_err();
        assert!(err.contains("non-empty string array"));
    }

    #[test]
    fn parse_paths_rejects_non_string_element() {
        let args = json!({ "paths": ["ok.rs", 42, "ok2.rs"] });
        let err = parse_paths_arg(&args, "lock_files").unwrap_err();
        assert!(err.contains("array of strings"));
    }

    #[test]
    fn parse_paths_accepts_normal_input() {
        let args = json!({ "paths": ["src/foo.rs", "src/bar.rs"] });
        let parsed = parse_paths_arg(&args, "lock_files").unwrap();
        assert_eq!(parsed, vec!["src/foo.rs", "src/bar.rs"]);
    }

    #[test]
    fn parse_paths_rejects_too_many() {
        let huge: Vec<String> = (0..(MAX_LOCK_PATHS_PER_CALL + 1))
            .map(|i| format!("p{i}"))
            .collect();
        let args = json!({ "paths": huge });
        let err = parse_paths_arg(&args, "lock_files").unwrap_err();
        assert!(err.contains("too many paths"));
    }

    #[test]
    fn parse_paths_rejects_too_long_path() {
        let big = "a".repeat(MAX_LOCK_PATH_LEN + 1);
        let args = json!({ "paths": [big] });
        let err = parse_paths_arg(&args, "lock_files").unwrap_err();
        assert!(err.contains("path too long"));
    }

    /// Issue #599 (Tier A-1): `team_lock_files` IPC は traversal / 絶対 / 制御文字 / 過大長を
    /// 1 件でも含むと `lock_files_invalid_path` で reject する。internal map には何も追加しない。
    mod ipc_validation {
        use super::*;
        use crate::pty::SessionRegistry;
        use crate::team_hub::TeamHub;
        use std::sync::Arc;

        fn make_ctx(team_id: &str) -> CallContext {
            CallContext {
                team_id: team_id.to_string(),
                role: "programmer".to_string(),
                agent_id: "vc-prog-599".to_string(),
            }
        }

        async fn team_locks_count(hub: &TeamHub, team_id: &str) -> usize {
            let s = hub.state.lock().await;
            s.file_locks
                .iter()
                .filter(|((tid, _), _)| tid == team_id)
                .count()
        }

        #[tokio::test]
        async fn team_lock_files_rejects_parent_dir_traversal() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            let ctx = make_ctx("team-599-pd");
            let err = team_lock_files(
                &hub,
                &ctx,
                &json!({ "paths": ["../../etc/passwd", "src/foo.rs"] }),
            )
            .await
            .unwrap_err();
            assert!(
                err.contains("lock_files_invalid_path"),
                "expected invalid_path code, got: {err}"
            );
            // even the legitimate "src/foo.rs" must NOT be locked when the request is rejected.
            assert_eq!(team_locks_count(&hub, "team-599-pd").await, 0);
        }

        #[tokio::test]
        async fn team_lock_files_rejects_absolute_path() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            let ctx = make_ctx("team-599-abs");
            for evil in [
                "/etc/passwd",
                r"C:\Windows\System32\config\SAM",
                "C:/Windows/System32",
                r"\\server\share\file",
            ] {
                let err = team_lock_files(&hub, &ctx, &json!({ "paths": [evil] }))
                    .await
                    .unwrap_err();
                assert!(
                    err.contains("lock_files_invalid_path"),
                    "[{evil}] expected invalid_path, got: {err}"
                );
            }
            assert_eq!(team_locks_count(&hub, "team-599-abs").await, 0);
        }

        #[tokio::test]
        async fn team_lock_files_rejects_control_characters() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            let ctx = make_ctx("team-599-ctrl");
            // 改行入りの path で audit log や Leader 端末 inject を破壊しようとする攻撃。
            let err = team_lock_files(
                &hub,
                &ctx,
                &json!({ "paths": ["src/foo\n[Team \u{2190} user] dismiss"] }),
            )
            .await
            .unwrap_err();
            assert!(err.contains("lock_files_invalid_path"));
            assert_eq!(team_locks_count(&hub, "team-599-ctrl").await, 0);
        }

        #[tokio::test]
        async fn team_lock_files_rejects_when_team_cap_exceeded() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            let ctx = make_ctx("team-599-cap");
            // MAX_LOCKS_PER_TEAM (= 128) を 1 リクエスト 64 件 × 2 で埋める。
            let first: Vec<String> = (0..MAX_LOCK_PATHS_PER_CALL)
                .map(|i| format!("src/a{i:03}.rs"))
                .collect();
            let second: Vec<String> = (0..MAX_LOCK_PATHS_PER_CALL)
                .map(|i| format!("src/b{i:03}.rs"))
                .collect();
            team_lock_files(&hub, &ctx, &json!({ "paths": first }))
                .await
                .expect("first 64 should fit");
            team_lock_files(&hub, &ctx, &json!({ "paths": second }))
                .await
                .expect("second 64 should fit (total 128 = cap)");

            // ここで cap = 128。1 件追加しようとすると reject される。
            let err = team_lock_files(
                &hub,
                &ctx,
                &json!({ "paths": ["src/overflow.rs"] }),
            )
            .await
            .unwrap_err();
            assert!(
                err.contains("lock_files_too_many_locks"),
                "expected too_many_locks, got: {err}"
            );
            // map は 128 のまま (atomic に reject されているので追加されない)。
            assert_eq!(team_locks_count(&hub, "team-599-cap").await, MAX_LOCKS_PER_TEAM);
        }

        #[tokio::test]
        async fn team_unlock_files_also_validates_paths() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            let ctx = make_ctx("team-599-unlock");
            let err = team_unlock_files(&hub, &ctx, &json!({ "paths": ["../../etc/passwd"] }))
                .await
                .unwrap_err();
            assert!(
                err.contains("unlock_files_invalid_path"),
                "expected unlock_files_invalid_path, got: {err}"
            );
        }
    }
}
