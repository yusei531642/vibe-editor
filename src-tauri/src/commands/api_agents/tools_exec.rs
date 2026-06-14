// api_agents/tools_exec — API エージェントの bash (shell) ツール (Issue #1034, Codex parity Phase 2a)。
//
// スコープ: bash。安全モデルは **workspace-write**:
//   - cwd を active project root に固定して実行 (封じ込め)。
//   - 露出は auto 経路のみ。`api_agent_send` は toolMode==='readOnly' / tool 非対応 provider を
//     tools=None (SSE chat) に degrade するため、bash は tool-calling ループ (auto) のときだけ公開。
//   - timeout 超過時は kill_on_drop で子プロセスを確実に kill。出力はサイズ上限で truncate。
//
// 実行シェルは OS 依存: unix=`sh -c`, windows=`cmd /C` (CLAUDE.md: Windows 11 を優先動作確認)。
//
// ツール種別/結果型 (`ToolSpec` / `ToolOutcome`) は tools.rs と共有する。

use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;

use super::tools::{ToolOutcome, ToolSpec};

/// bash の既定タイムアウト (ms)。
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// bash のタイムアウト上限 (ms)。
const MAX_TIMEOUT_MS: u64 = 120_000;
/// model へ返す結合出力の最大バイト数。
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

fn err(content: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        content: content.into(),
        is_error: true,
    }
}

/// exec 系 tool 名か。team / write / read とは別 dispatch (async)。
pub(super) fn is_exec_tool(name: &str) -> bool {
    name == "bash"
}

/// auto 経路でモデルに公開する shell ツール定義。
pub(super) fn builtin_exec_tools() -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: "bash",
        description: "Run a shell command from the project root (workspace-write). \
            Use for builds, tests, git, search, etc. Combined stdout/stderr and the \
            exit code are returned, truncated to 64KB. Commands run with a timeout \
            (default 30s, max 120s) and are confined to the project root as the working directory.",
        parameters: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to run (sh -c on unix, cmd /C on Windows)." },
                "timeout_ms": { "type": "integer", "description": "Timeout in milliseconds (default 30000, max 120000)." }
            },
            "required": ["command"]
        }),
    }]
}

/// exec 系 tool を実行する (async: tokio::process)。
pub(super) async fn execute_exec_tool(project_root: &str, name: &str, args: &Value) -> ToolOutcome {
    match name {
        "bash" => run_bash(project_root, args).await,
        other => err(format!("unknown exec tool: {other}")),
    }
}

/// OS に応じた shell コマンドを組み立てる。
fn build_command(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(command);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(command);
        c
    }
}

/// 結合出力を MAX_OUTPUT_BYTES で char 境界に配慮して truncate する。
fn truncate_output(mut s: String) -> String {
    if s.len() <= MAX_OUTPUT_BYTES {
        return s;
    }
    let mut end = MAX_OUTPUT_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("\n…(output truncated; exceeds 64KB)");
    s
}

async fn run_bash(project_root: &str, args: &Value) -> ToolOutcome {
    let root = project_root.trim();
    if root.is_empty() {
        return err("no project is open");
    }
    let root_canon = match std::fs::canonicalize(root) {
        Ok(p) => p,
        Err(e) => return err(format!("project root unavailable: {e}")),
    };
    let Some(command) = args.get("command").and_then(Value::as_str) else {
        return err("bash requires a string 'command' argument");
    };
    if command.trim().is_empty() {
        return err("bash 'command' must not be empty");
    }
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);

    let mut cmd = build_command(command);
    cmd.current_dir(&root_canon)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // timeout で future を drop したとき子プロセスを確実に kill する。
        .kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return err(format!("failed to start shell: {e}")),
    };
    let output =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return err(format!("command failed: {e}")),
            // timeout: wait_with_output future が drop され、kill_on_drop で子が kill される。
            Err(_) => return err(format!("command timed out after {timeout_ms}ms (killed)")),
        };

    let mut text = String::new();
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "terminated by signal".to_string());
    text.push_str(&format!("exit: {code}\n"));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.trim().is_empty() {
        text.push_str("--- stdout ---\n");
        text.push_str(&stdout);
        if !stdout.ends_with('\n') {
            text.push('\n');
        }
    }
    if !stderr.trim().is_empty() {
        text.push_str("--- stderr ---\n");
        text.push_str(&stderr);
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        text.push_str("(no output)");
    }
    // 非ゼロ exit は「tool 実行エラー」ではなくコマンドの正常な結果 (grep no-match 等) なので
    // is_error=false とし、exit code を本文に載せて model に解釈させる。
    ToolOutcome {
        content: truncate_output(text),
        is_error: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_exec_tool_recognizes_bash() {
        assert!(is_exec_tool("bash"));
        assert!(!is_exec_tool("read_file"));
        assert!(!is_exec_tool("write_file"));
        let names: Vec<&str> = builtin_exec_tools().iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["bash"]);
    }

    #[tokio::test]
    async fn bash_empty_project_root_is_error() {
        let out = execute_exec_tool("", "bash", &json!({ "command": "echo hi" })).await;
        assert!(out.is_error);
        assert!(out.content.contains("no project"));
    }

    #[tokio::test]
    async fn bash_requires_command() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_exec_tool(&root, "bash", &json!({})).await;
        assert!(out.is_error);
        let blank = execute_exec_tool(&root, "bash", &json!({ "command": "   " })).await;
        assert!(blank.is_error);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_runs_in_project_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let root_str = root.to_string_lossy().to_string();
        let out = execute_exec_tool(&root_str, "bash", &json!({ "command": "pwd" })).await;
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("exit: 0"));
        assert!(out.content.contains(root.file_name().unwrap().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_captures_stdout_and_exit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_exec_tool(&root, "bash", &json!({ "command": "echo hello" })).await;
        assert!(!out.is_error);
        assert!(out.content.contains("exit: 0"));
        assert!(out.content.contains("hello"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_reports_nonzero_exit_without_tool_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_exec_tool(&root, "bash", &json!({ "command": "exit 3" })).await;
        // 非ゼロ exit は tool error 扱いにしない (本文に exit code を載せる)。
        assert!(!out.is_error);
        assert!(out.content.contains("exit: 3"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_times_out_and_kills() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_exec_tool(
            &root,
            "bash",
            &json!({ "command": "sleep 5", "timeout_ms": 200 }),
        )
        .await;
        assert!(out.is_error);
        assert!(out.content.contains("timed out"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_truncates_large_output() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        // 200KB 超を出力して truncate を確認
        let out = execute_exec_tool(
            &root,
            "bash",
            &json!({ "command": "head -c 200000 /dev/zero | tr '\\0' 'a'" }),
        )
        .await;
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("truncated"));
        assert!(out.content.len() <= MAX_OUTPUT_BYTES + 200);
    }
}
