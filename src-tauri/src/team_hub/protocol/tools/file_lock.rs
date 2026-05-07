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

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

use super::error::ToolError;

/// 1 リクエストで指定できる path 数の上限 (DoS 抑止)。
const MAX_LOCK_PATHS_PER_CALL: usize = 64;
/// 1 path あたりの最大バイト長 (異常な巨大 path を弾く)。
const MAX_LOCK_PATH_LEN: usize = 4 * 1024;

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
pub async fn team_lock_files(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let paths = parse_paths_arg(args, "lock_files")?;
    let result = hub
        .try_acquire_file_locks(&ctx.team_id, &ctx.agent_id, &ctx.role, &paths)
        .await;
    Ok(json!({
        "success": true,
        "locked": result.locked,
        "conflicts": result.conflicts,
    }))
}

/// `team_unlock_files`: 自分が保持する paths のロックを解放。他 agent の lock は silent skip。
pub async fn team_unlock_files(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let paths = parse_paths_arg(args, "unlock_files")?;
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
}
