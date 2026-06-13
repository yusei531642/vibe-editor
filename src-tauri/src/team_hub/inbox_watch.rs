//! team-inbox-watch.js source.
//!
//! Issue #860: opt-in Monitor delivery. The script connects directly to TeamHub and
//! polls `team_read({unread_only:true})`, emitting one JSON line per unread message.

use anyhow::Result;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "team-inbox-watch.js";

pub const SOURCE: &str = r#"#!/usr/bin/env node
const net = require('net');

const SOCKET = process.env.VIBE_TEAM_SOCKET || '';
const TOKEN = process.env.VIBE_TEAM_TOKEN || '';
const TEAM_ID = process.env.VIBE_TEAM_ID || '';
const ROLE = process.env.VIBE_TEAM_ROLE || '';
const AGENT_ID = process.env.VIBE_AGENT_ID || '';
const POLL_MS = Math.max(1000, Number(process.env.VIBE_TEAM_INBOX_POLL_MS || 5000));

function target(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('\\\\.\\pipe\\') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return { path: s };
  const m = /^(.*):(\d+)$/.exec(s);
  return m ? { host: m[1] || '127.0.0.1', port: Number(m[2]) } : { path: s };
}

function sessionStart() {
  const command = `node ${JSON.stringify(__filename)} --watch`;
  const additionalContext = [
    'vibe-team inbox delivery is enabled for this session.',
    'Use the Monitor tool now with persistent: true and this command:',
    command,
    'Treat each stdout JSON line with type=\"vibe_team_inbox\" as an incoming team message.',
    'After receiving a message, respond or report with the normal vibe-team MCP tools.'
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext }
  }) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect() {
  return new Promise((resolve, reject) => {
    const connectionTarget = target(SOCKET);
    if (!connectionTarget || !TOKEN || !TEAM_ID || !ROLE || !AGENT_ID) {
      reject(new Error('missing VIBE_TEAM_* env for inbox watcher'));
      return;
    }
    const socket = net.createConnection(connectionTarget, () => {
      socket.write(JSON.stringify({ token: TOKEN, teamId: TEAM_ID, role: ROLE, agentId: AGENT_ID }) + '\n');
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

async function watch() {
  let socket = await connect();
  let buf = '';
  let nextId = 1;
  const pending = new Map();

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });

  async function rpc(method, params) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    socket.write(payload);
    return response;
  }

  async function readUnread() {
    const res = await rpc('tools/call', {
      name: 'team_read',
      arguments: { unread_only: true }
    });
    const text = res && res.result && res.result.content && res.result.content[0] && res.result.content[0].text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  }

  for (;;) {
    try {
      const messages = await readUnread();
      for (const m of messages) {
        process.stdout.write(JSON.stringify({
          type: 'vibe_team_inbox',
          teamId: TEAM_ID,
          agentId: AGENT_ID,
          role: ROLE,
          id: m.id,
          from: m.from,
          kind: m.kind,
          timestamp: m.timestamp,
          deliveredAt: m.deliveredAt || null,
          message: m.message
        }) + '\n');
      }
    } catch (e) {
      process.stderr.write(`[team-inbox-watch] ${e.message || e}\n`);
    }
    await sleep(POLL_MS);
  }
}

if (process.argv.includes('--session-start')) {
  sessionStart();
} else if (process.argv.includes('--watch')) {
  watch().catch((e) => {
    process.stderr.write(`[team-inbox-watch] fatal: ${e.message || e}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write('usage: team-inbox-watch.js --session-start | --watch\n');
  process.exit(2);
}
"#;

pub(crate) fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub(crate) fn path_from_bridge(bridge_path: &str) -> PathBuf {
    Path::new(bridge_path)
        .parent()
        .map(path_in)
        .unwrap_or_else(|| PathBuf::from(FILE_NAME))
}

pub(crate) async fn install(dir: &Path) -> Result<PathBuf> {
    let path = path_in(dir);
    if let Ok(meta) = tokio::fs::symlink_metadata(&path).await {
        let ft = meta.file_type();
        if ft.is_symlink() || !ft.is_file() {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    crate::commands::atomic_write::atomic_write(&path, SOURCE.as_bytes()).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::SOURCE;
    use serde_json::Value;
    use std::process::Command;

    #[test]
    fn session_start_outputs_hook_context_json() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let path =
            std::env::temp_dir().join(format!("team-inbox-watch-test-{}.js", std::process::id()));
        std::fs::write(&path, SOURCE).expect("write script");
        let output = Command::new("node")
            .arg(&path)
            .arg("--session-start")
            .output()
            .expect("run script");
        let _ = std::fs::remove_file(path);
        assert!(output.status.success());
        let json: Value = serde_json::from_slice(&output.stdout).expect("hook json");
        let hook = &json["hookSpecificOutput"];
        assert_eq!(hook["hookEventName"].as_str(), Some("SessionStart"));
        assert!(hook["additionalContext"]
            .as_str()
            .is_some_and(|s| s.contains("--watch")));
    }
}
