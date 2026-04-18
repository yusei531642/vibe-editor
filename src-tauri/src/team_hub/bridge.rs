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

// Issue #62: SOCKET / TOKEN が欠けているときは localFallback せず即 fail する。
// localFallback で initialize/tools/list に成功してしまうと MCP クライアント側は
// 「使える」前提で振る舞い、実際には team tools が動かない症状が分かりにくくなる。
if (!SOCKET || !TOKEN) {
  process.stderr.write('[team-bridge] FATAL: missing VIBE_TEAM_SOCKET or VIBE_TEAM_TOKEN — exiting\n');
  process.exit(1);
}

const [host, portStr] = SOCKET.split(':');
const port = parseInt(portStr || '0', 10);

let socket = null;
let connected = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
const pendingOut = [];

// Issue #61: 500ms 固定再接続を exponential backoff に置き換える。
// 連続失敗が MAX_RECONNECT_ATTEMPTS を超えたら stderr にエラーを出して exit する。
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_RECONNECT_DELAY_MS = 30_000;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    process.stderr.write(
      '[team-bridge] giving up after ' + MAX_RECONNECT_ATTEMPTS + ' reconnect attempts\n'
    );
    process.exit(1);
  }
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * Math.pow(2, reconnectAttempt - 1));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  // Issue #61: pending setTimeout が Node.js の event loop を握り続けないように unref。
  if (reconnectTimer && typeof reconnectTimer.unref === 'function') {
    reconnectTimer.unref();
  }
}

function connect() {
  socket = net.createConnection({ host: host || '127.0.0.1', port }, () => {
    const hello = JSON.stringify({ token: TOKEN, teamId: TEAM_ID, role: ROLE, agentId: AGENT_ID });
    socket.write(hello + '\n');
    connected = true;
    reconnectAttempt = 0;
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
    scheduleReconnect();
  };
  socket.on('end', onClose);
  socket.on('close', onClose);
  socket.on('error', (err) => {
    // Issue #61: 連続エラーを silent に捨てず、少なくとも stderr に残す。
    try {
      process.stderr.write('[team-bridge] socket error: ' + (err && err.message ? err.message : String(err)) + '\n');
    } catch {}
  });
}

connect();

let stdinBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) !== -1) {
    const line = stdinBuf.slice(0, nl).replace(/\r$/, '');
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    if (!connected) {
      // hub 未接続の間は送信を保留する (再接続できたらまとめて流す)。
      pendingOut.push(line + '\n');
      continue;
    }
    socket.write(line + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
"#;
