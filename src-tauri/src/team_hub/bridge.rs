// team-bridge.js のソース (旧 team-hub.ts の BRIDGE_SOURCE 定数)
//
// 各 Claude Code / Codex プロセスに spawn される薄い MCP ブリッジ。
// stdio MCP (JSON-RPC) を TeamHub TCP に中継するだけ。
// 内容は本文末尾に const SOURCE: &str として埋め込む (Rust binary に同梱)。
//
// 注意: 旧 Node 実装と完全互換。テンプレート文字列の `\\n` などはそのまま保持。

pub const SOURCE: &str = r#"#!/usr/bin/env node
/**
 * team-bridge.js — vibe-editor が自動生成する薄いMCPブリッジ。
 * stdio MCP (Claude Code / Codex が喋る JSON-RPC) を、メインプロセス側の
 * TeamHub TCP サーバーへ中継するだけ。状態も永続化も持たない。
 */
const net = require('net');

const SOCKET = process.env.VIVE_TEAM_SOCKET || '';
const TOKEN = process.env.VIVE_TEAM_TOKEN || '';
const TEAM_ID = process.env.VIVE_TEAM_ID || '';
const ROLE = process.env.VIVE_TEAM_ROLE || 'unknown';
const AGENT_ID = process.env.VIVE_AGENT_ID || '';

if (!SOCKET || !TOKEN) {
  process.stderr.write('[team-bridge] missing VIVE_TEAM_SOCKET or VIVE_TEAM_TOKEN\n');
}

const [host, portStr] = SOCKET.split(':');
const port = parseInt(portStr || '0', 10);

let socket = null;
let connected = false;
let reconnectTimer = null;
const pendingOut = [];

function connect() {
  socket = net.createConnection({ host: host || '127.0.0.1', port }, () => {
    const hello = JSON.stringify({ token: TOKEN, teamId: TEAM_ID, role: ROLE, agentId: AGENT_ID });
    socket.write(hello + '\n');
    connected = true;
    for (const line of pendingOut) socket.write(line);
    pendingOut.length = 0;
  });

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) process.stdout.write(line + '\n');
    }
  });

  const onClose = () => {
    connected = false;
    try { socket && socket.destroy(); } catch {}
    socket = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 500);
    }
  };
  socket.on('end', onClose);
  socket.on('close', onClose);
  socket.on('error', () => { /* onClose で処理 */ });
}

if (SOCKET && TOKEN) connect();

let stdinBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) !== -1) {
    const line = stdinBuf.slice(0, nl).replace(/\r$/, '');
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;

    if (!connected || !SOCKET || !TOKEN) {
      try {
        const req = JSON.parse(line);
        const resp = localFallback(req);
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      } catch {}
      if (connected) {
        pendingOut.push(line + '\n');
      }
      continue;
    }
    socket.write(line + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));

function localFallback(req) {
  const { method, id } = req;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vive-team', version: '2.0.0-offline' }
        }
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [] } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    default:
      if (id !== undefined && id !== null) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'hub offline' } };
      }
      return null;
  }
}
"#;
