//! team-inbox-watch.js source.
//!
//! Issue #860: opt-in Monitor delivery. The script connects directly to TeamHub and
//! polls `team_read({unread_only:true})`, emitting one JSON line per unread message.

use anyhow::Result;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "team-inbox-watch.js";

pub const SOURCE: &str = r#"#!/usr/bin/env node
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOCKET = process.env.VIBE_TEAM_SOCKET || '';
const TOKEN = process.env.VIBE_TEAM_TOKEN || '';
const TEAM_ID = process.env.VIBE_TEAM_ID || '';
const ROLE = process.env.VIBE_TEAM_ROLE || '';
const AGENT_ID = process.env.VIBE_AGENT_ID || '';
const POLL_MS = Math.max(1000, Number(process.env.VIBE_TEAM_INBOX_POLL_MS || 5000));

// Issue #1072 Part1: per-agent high-water mark (last delivered message id) を run dir に永続化し、
// watcher 再起動時にそこから resume する (agmsg #107 相当)。delivery cursor (hwm) を server 側
// read_by から分離し、emit の「後」に hwm を進めることで at-least-once (drop より duplicate) にする。
function safeSeg(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  // nit-2 (defense-in-depth): teamId は dir 成分に使うため "." / ".." は path traversal になりうる
  // (Rust 側はファイル名 suffix で保護されるが JS は dir 成分なので未保護)。'unknown' へ倒す。
  if (s === '' || s === '.' || s === '..') return 'unknown';
  return s;
}
function watermarkPath() {
  // canonical: ~/.vibe-editor/team-inbox-watermarks/<team>/<agent>.json (この watcher が唯一の読み書き手)。
  return path.join(os.homedir(), '.vibe-editor', 'team-inbox-watermarks', safeSeg(TEAM_ID), safeSeg(AGENT_ID) + '.json');
}
function loadWatermark() {
  try {
    const raw = fs.readFileSync(watermarkPath(), 'utf8');
    const v = JSON.parse(raw);
    const id = Number(v && v.lastDeliveredId);
    return Number.isInteger(id) && id >= 0 ? id : 0;
  } catch {
    return 0; // 不在 / 破損 / 非数値は 0 から (= ライブ全件、取りこぼさない方向)。
  }
}
function saveWatermark(lastDeliveredId) {
  try {
    const p = watermarkPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const body = JSON.stringify({ schemaVersion: 1, teamId: TEAM_ID, agentId: AGENT_ID, lastDeliveredId, updatedAt: new Date().toISOString() });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p); // atomic 置換。
  } catch (e) {
    process.stderr.write(`[team-inbox-watch] watermark persist failed: ${e.message || e}\n`);
  }
}

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

  // Issue #1072: hwm (since_id) を cursor に「id>hwm・未配信 (delivered_to 除外)」を取得する。
  // mark_read:true で read_by も前進させる (dashboard 未読セマンティクス維持)。配信判定は hwm が
  // 担うため read_by を先に進めても silent drop しない (unread_only:false で read_by は gate しない)。
  async function readSince(hwm) {
    const res = await rpc('tools/call', {
      name: 'team_read',
      arguments: { since_id: hwm, unread_only: false, mark_read: true, exclude_delivered: true }
    });
    const text = res && res.result && res.result.content && res.result.content[0] && res.result.content[0].text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    // id 昇順を保証 (hwm を単調に進めるため)。
    msgs.sort((a, b) => Number(a.id) - Number(b.id));
    return msgs;
  }

  let hwm = loadWatermark();
  for (;;) {
    try {
      const messages = await readSince(hwm);
      for (const m of messages) {
        if (Number(m.id) <= hwm) continue; // 念のため二重防御。
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
        // emit の「後」に hwm を前進 + 永続化 (agmsg #107: at-least-once)。
        // TODO(#1072 followup): 現状は emit 毎に hwm を write している。poll batch 後に 1 回へ
        // まとめると write 回数を減らせる (perf)。今回は対応しない (crash 時の重複を最小化する側に倒す)。
        hwm = Number(m.id);
        saveWatermark(hwm);
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
