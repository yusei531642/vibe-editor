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

const SOCKET = process.env.VIBE_TEAM_SOCKET || '';
const TOKEN = process.env.VIBE_TEAM_TOKEN || '';
const TEAM_ID = process.env.VIBE_TEAM_ID || '';
const ROLE = process.env.VIBE_TEAM_ROLE || 'unknown';
const AGENT_ID = process.env.VIBE_AGENT_ID || '';

// Issue #62: SOCKET / TOKEN が欠落しているときは、offline fallback で「繋がっているフリ」を
// するのではなく、initialize を明示的にエラーで返すことで Claude / Codex が
// vibe-team MCP を「失敗サーバ」として認識できるようにする (ユーザーが気付きやすい)。
const MISSING_HUB_ENV = !SOCKET || !TOKEN;
if (MISSING_HUB_ENV) {
  process.stderr.write('[team-bridge] missing VIBE_TEAM_SOCKET or VIBE_TEAM_TOKEN — team tools disabled\n');
}

const [host, portStr] = SOCKET.split(':');
const port = parseInt(portStr || '0', 10);

let socket = null;
let connected = false;
let reconnectTimer = null;
const pendingOut = [];
// Issue #61: 500ms 固定 retry を exponential backoff + 上限付きに変更。
// hub が止まっているときの busy loop と CPU 負荷を避ける。
let retryCount = 0;
const MAX_RETRIES = 12;         // 合計 ~60 秒程度で諦める
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
let givenUp = false;

function nextBackoffMs() {
  // 500ms → 1s → 2s → ... (cap 10s)
  const ms = Math.min(BASE_RETRY_MS * 2 ** retryCount, MAX_RETRY_MS);
  retryCount += 1;
  return ms;
}

function connect() {
  socket = net.createConnection({ host: host || '127.0.0.1', port }, () => {
    const hello = JSON.stringify({ token: TOKEN, teamId: TEAM_ID, role: ROLE, agentId: AGENT_ID });
    socket.write(hello + '\n');
    connected = true;
    retryCount = 0; // 成功したので backoff リセット
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
    if (givenUp) return;
    if (retryCount >= MAX_RETRIES) {
      givenUp = true;
      process.stderr.write(`[team-bridge] giving up after ${MAX_RETRIES} reconnect attempts\n`);
      return;
    }
    if (!reconnectTimer) {
      const delay = nextBackoffMs();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }
  };
  socket.on('end', onClose);
  socket.on('close', onClose);
  socket.on('error', () => { /* onClose で処理 */ });
}

if (!MISSING_HUB_ENV) connect();

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
  // Issue #62: SOCKET/TOKEN 欠如時は initialize をエラーで返し、Claude/Codex に
  // 「vibe-team MCP は失敗した」ことを明示する。成功応答にしておくと "空の tools/list で
  // Claude だけ動いている" ように見え、ユーザーが故障に気付けない。
  // hub への接続は試みたが未接続 (= まだ connecting 中) は従来どおり pending 扱い。
  const { method, id } = req;
  if (MISSING_HUB_ENV) {
    if (id !== undefined && id !== null) {
      return {
        jsonrpc: '2.0', id,
        error: {
          code: -32001,
          message: 'vibe-team bridge is not configured (VIBE_TEAM_SOCKET / VIBE_TEAM_TOKEN missing)'
        }
      };
    }
    return null;
  }
  switch (method) {
    case 'initialize':
      // 通常は TeamHub が応答する。ここに落ちるのは hub 未接続時のみ → pending 保留
      return null;
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
