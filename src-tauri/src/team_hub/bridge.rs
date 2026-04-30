// team-bridge.js のソース (旧 team-hub.ts の BRIDGE_SOURCE 定数)
//
// 各 Claude Code / Codex プロセスに spawn される薄い MCP ブリッジ。
// stdio MCP (JSON-RPC) を TeamHub のローカル socket / named pipe に中継するだけ。
// 内容は本文末尾に const SOURCE: &str として埋め込む (Rust binary に同梱)。
//
// 注意: 旧 Node 実装と完全互換。テンプレート文字列の `\\n` などはそのまま保持。
//
// 独立性 (他のバックグラウンド agent teams 等と競合しないための前提):
//   - 環境変数は VIBE_TEAM_* / VIBE_AGENT_ID 名前空間 (他フレームワークの AGENT_TEAMS_* 等とは別)
//   - bridge スクリプトは ~/.vibe-editor/team-bridge.js (~/.claude/, ~/.codex/, ~/.config/agent-teams/ には触れない)
//   - MCP server entry 名は "vibe-team" (~/.claude.json / ~/.codex/config.toml 上で固有)
//   - agentId prefix は "vc-" (Renderer 側採番分のみ)
//   - チーム間の動的ロールも Hub 側 team_id スコープで分離される

pub const SOURCE: &str = r#"#!/usr/bin/env node
/**
 * team-bridge.js — vibe-editor が自動生成する薄いMCPブリッジ。
 * stdio MCP (Claude Code / Codex が喋る JSON-RPC) を、メインプロセス側の
 * TeamHub のローカル socket / named pipe へ中継するだけ。状態も永続化も持たない。
 */
const net = require('net');

const SOCKET = process.env.VIBE_TEAM_SOCKET || '';
const TOKEN = process.env.VIBE_TEAM_TOKEN || '';
const TEAM_ID = process.env.VIBE_TEAM_ID || '';
// Issue #339: 既定値 'unknown' を撤廃する。これがあると env 未設定の bridge が空 handshake で
// connect → Hub に reject → 即再接続のループになりログを汚染する。
const ROLE = process.env.VIBE_TEAM_ROLE || '';
const AGENT_ID = process.env.VIBE_AGENT_ID || '';

// Issue #62 / #339: env が 1 つでも欠けているなら connect しない。
// 旧実装は SOCKET/TOKEN だけ判定していたため、TEAM_ID/ROLE/AGENT_ID 欠落で空 handshake
// → Hub の `empty field` reject → 0.8 秒間隔の再接続ループが発生していた。
const missingEnv = [];
if (!SOCKET) missingEnv.push('VIBE_TEAM_SOCKET');
if (!TOKEN) missingEnv.push('VIBE_TEAM_TOKEN');
if (!TEAM_ID) missingEnv.push('VIBE_TEAM_ID');
if (!ROLE) missingEnv.push('VIBE_TEAM_ROLE');
if (!AGENT_ID) missingEnv.push('VIBE_AGENT_ID');
const MISSING_HUB_ENV = missingEnv.length > 0;
if (MISSING_HUB_ENV) {
  process.stderr.write('[team-bridge] missing env: ' + missingEnv.join(', ') + ' — team tools disabled\n');
}

function resolveConnectionTarget(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('\\\\.\\pipe\\') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return { path: trimmed };
  }
  const m = /^(.*):(\d+)$/.exec(trimmed);
  if (m) {
    return { host: m[1] || '127.0.0.1', port: parseInt(m[2], 10) };
  }
  return { path: trimmed };
}
const connectionTarget = resolveConnectionTarget(SOCKET);

let socket = null;
let connected = false;
let reconnectTimer = null;
const pendingOut = [];
// Issue #100: 未接続中に積める pending request の上限。
// 想定: handshake 中の数百ms に initialize / tools/list 程度。
// 万一 hub が長時間繋がらない場合のメモリ青天井を防ぐため上限を設ける。
const MAX_PENDING = 256;
// Issue #100: pending エントリは投入時刻も持ち、TTL 超過分は drop する。
const PENDING_TTL_MS = 30 * 1000;
// Issue #61: 500ms 固定 retry を exponential backoff + 上限付きに変更。
// hub が止まっているときの busy loop と CPU 負荷を避ける。
let retryCount = 0;
const MAX_RETRIES = 12;         // 合計 ~60 秒程度で諦める
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
let givenUp = false;

// Issue #340: Hub の IDLE_TIMEOUT (300s) より十分短い間隔で no-op 通知を送り、
// 正常稼働中の Leader が「データ無し」で切られて再接続を繰り返すのを防ぐ。
const KEEPALIVE_INTERVAL_MS = 90 * 1000;
let keepaliveTimer = null;
function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (!socket || !connected || socket.destroyed) return;
    try {
      socket.write('{"jsonrpc":"2.0","method":"team-hub/keepalive"}\n');
    } catch (e) {
      // 書き込み失敗は onClose で拾う
    }
  }, KEEPALIVE_INTERVAL_MS);
  // keepalive timer 単独で Node プロセスを生かさない (stdin 終了で素直に exit するため)
  if (keepaliveTimer && typeof keepaliveTimer.unref === 'function') {
    keepaliveTimer.unref();
  }
}
function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function nextBackoffMs() {
  // 500ms → 1s → 2s → ... (cap 10s)
  const ms = Math.min(BASE_RETRY_MS * 2 ** retryCount, MAX_RETRY_MS);
  retryCount += 1;
  return ms;
}

function connect() {
  socket = net.createConnection(connectionTarget, () => {
    const hello = JSON.stringify({ token: TOKEN, teamId: TEAM_ID, role: ROLE, agentId: AGENT_ID });
    socket.write(hello + '\n');
    connected = true;
    // Issue #339: retryCount は TCP 接続時ではなく Hub から最初のバイトを受信した時に
    // リセットする。handshake reject 後の即再接続ループで backoff が常に 500ms に戻るのを防ぐ。
    // Issue #100: connect 完了で pending request を flush。
    // TTL 切れの pending は捨て、生きているものだけ送る。
    const now = Date.now();
    let flushed = 0, dropped = 0;
    for (const entry of pendingOut) {
      if (now - entry.t > PENDING_TTL_MS) { dropped += 1; continue; }
      socket.write(entry.line);
      flushed += 1;
    }
    pendingOut.length = 0;
    if (flushed || dropped) {
      process.stderr.write(`[team-bridge] flushed ${flushed} pending request(s), dropped ${dropped} stale\n`);
    }
    // Issue #340: handshake 直後に keepalive を起動して Hub の idle drop を防ぐ。
    startKeepalive();
  });

  let buf = '';
  // Issue #339: socket ごとにフラグを持ち、同 socket での data 初回受信時のみ retryCount を
  // リセットする。再接続で新しい socket になったらまた false スタート。
  let resetOnFirstData = false;
  socket.on('data', (chunk) => {
    if (!resetOnFirstData) {
      retryCount = 0;
      resetOnFirstData = true;
    }
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
    // Issue #340: 切断時は keepalive を止める。次回 connect 成功時に再起動する。
    stopKeepalive();
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

    // Issue #100: 未接続時の挙動を 3 状態に整理する。
    //   1) MISSING_HUB_ENV: env 不在 = 永続的に hub 無し → localFallback で error 応答
    //   2) givenUp:        再接続を諦めた状態 → localFallback で error 応答
    //   3) それ以外の未接続: connect 中 → pendingOut に積み、connect 後に flush
    // 旧実装は (3) でも localFallback を呼んでいたため、initialize が null 応答 →
    // クライアントが応答待ちで詰まる、または成功扱いされてしまう問題があった。
    if (MISSING_HUB_ENV || givenUp) {
      try {
        const req = JSON.parse(line);
        const resp = localFallback(req);
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      } catch {}
      continue;
    }
    if (!connected) {
      // pending queue: 上限超過なら最古を捨てる
      if (pendingOut.length >= MAX_PENDING) {
        pendingOut.shift();
        process.stderr.write('[team-bridge] pending queue overflow, dropping oldest request\n');
      }
      pendingOut.push({ line: line + '\n', t: Date.now() });
      continue;
    }
    socket.write(line + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));

function localFallback(req) {
  // Issue #62 / #100: localFallback は env 不在 (MISSING_HUB_ENV) または再接続を
  // 諦めた状態 (givenUp) でのみ呼ばれる。connect 試行中は pendingOut に積むので
  // ここには到達しない。
  // 「失敗していること」を明示するため、id 付き request には error を返す。
  const { method, id } = req;
  const reason = MISSING_HUB_ENV
    ? 'vibe-team bridge is not configured (missing env: ' + missingEnv.join(', ') + ')'
    : 'vibe-team hub is unreachable (gave up reconnecting)';
  if (id !== undefined && id !== null) {
    return {
      jsonrpc: '2.0', id,
      error: { code: -32001, message: reason }
    };
  }
  // notification (id 無し) は応答不要
  return null;
}
"#;
