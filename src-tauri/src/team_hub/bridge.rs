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
const DEBUG_BRIDGE = process.env.VIBE_TEAM_DEBUG === '1' || process.env.VIBE_TEAM_DEBUG === 'true';
if (MISSING_HUB_ENV && DEBUG_BRIDGE) {
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
// Issue #1080: 未接続中に空の tools/list をローカル応答したら true にする。Hub 接続が
// 確立したら notifications/tools/list_changed を 1 度送って本物の tool 一覧を再取得させ、
// slow-hub 時に tool が消えたままになる退行を防ぐ。
let servedEmptyToolsList = false;

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
    // Issue #1080: 未接続中に initialize/tools/list をローカル即答していた場合、client は
    // 空の tool list を持っている。Hub 接続が確立したので list_changed を 1 度通知して
    // 再取得させ、本物の team tools を反映させる (stdout = client 宛、Hub 宛ではない)。
    if (servedEmptyToolsList) {
      servedEmptyToolsList = false;
      process.stdout.write('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n');
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

    // Issue #100 / #1080: 未接続時の挙動。env 不在/givenUp は localFallback、connect 済みは
    // Hub に中継。connect 試行中は MCP handshake (initialize/tools/list/ping/notifications) を
    // ローカル即答し、Hub 依存 (tools/call 等) だけ pendingOut に積む。旧実装は connect 試行中に
    // initialize も積んでいたため、Hub socket が stale だと 30s startup timeout していた。
    if (MISSING_HUB_ENV || givenUp) {
      try {
        const req = JSON.parse(line);
        const resp = localFallback(req);
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      } catch {}
      continue;
    }
    if (connected) {
      socket.write(line + '\n');
      continue;
    }
    // connect 試行中: handshake はローカル即答、Hub 依存だけ queue。
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed) {
      const hs = handshakeReply(parsed);
      if (hs !== undefined) {
        // tools/list を空応答したら、Hub 接続時に list_changed で再取得させる。
        if (parsed.method === 'tools/list') servedEmptyToolsList = true;
        if (hs) process.stdout.write(JSON.stringify(hs) + '\n');
        continue;
      }
    }
    // Hub 依存 request: pending queue に積む (上限超過なら最古を捨てる)。
    if (pendingOut.length >= MAX_PENDING) {
      pendingOut.shift();
      process.stderr.write('[team-bridge] pending queue overflow, dropping oldest request\n');
    }
    pendingOut.push({ line: line + '\n', t: Date.now() });
  }
});
process.stdin.on('end', () => process.exit(0));

// Issue #1080: Hub の生死に依存しない MCP ハンドシェイクのローカル応答を 1 箇所に集約する。
// initialize / tools/list / ping / notifications/* は env 不在でも givenUp でも connect 試行中でも
// 同じ応答でよい (Hub に問い合わせる必要が無い)。戻り値の意味:
//   - object   : その request への応答 (stdout に書く)
//   - null     : handshake だが応答不要 (notifications/* を握りつぶす)
//   - undefined: handshake ではない (= Hub 依存。caller が queue / error を決める)
function handshakeReply(req) {
  const { method, id } = req;
  const hasId = id !== undefined && id !== null;
  if (method === 'initialize' && hasId) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        // Issue #1080: listChanged:true。未接続中に空の tools/list を返した後、Hub 接続時に
        // notifications/tools/list_changed で本物の一覧を再取得させるために宣言する。
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'vibe-team', version: 'standalone-noop' }
      }
    };
  }
  if (method === 'tools/list' && hasId) {
    return { jsonrpc: '2.0', id, result: { tools: [] } };
  }
  if (method === 'ping' && hasId) {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }
  return undefined;
}

function localFallback(req) {
  // Issue #62 / #100 / #454 / #1080: localFallback は env 不在 (MISSING_HUB_ENV) または
  // 再接続を諦めた状態 (givenUp) でのみ呼ばれる。connect 試行中は stdin ハンドラ側で
  // handshakeReply / pendingOut に振り分けるのでここには到達しない。
  // handshake (initialize/tools/list/ping/notifications) は両状態とも同じくローカル応答し、
  // Hub 依存の tools/call 等だけ状態別に error 文言を変える。
  const hs = handshakeReply(req);
  if (hs !== undefined) return hs;

  const { method, id } = req;
  const hasId = id !== undefined && id !== null;
  if (MISSING_HUB_ENV) {
    // env 不在は standalone Codex / Claude 起動なので startup failure にしない。
    if (method === 'tools/call' && hasId) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message:
            'not a vibe-team session: missing env (' + missingEnv.join(', ') + '); start from a Canvas team session to use vibe-team tools'
        }
      };
    }
    if (hasId) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method not available in standalone vibe-team no-op mode' }
      };
    }
    return null;
  }
  // givenUp: hub があるはずの team session で再接続を諦めた異常系なので error を返す。
  if (hasId) {
    return {
      jsonrpc: '2.0', id,
      error: { code: -32001, message: 'vibe-team hub is unreachable (gave up reconnecting)' }
    };
  }
  // notification (id 無し) は応答不要
  return null;
}
"#;

#[cfg(test)]
mod tests {
    use super::SOURCE;
    use serde_json::Value;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// bridge を node で起動して input を stdin に流し、stdout の JSON 行を集める共通ヘルパ。
    /// `team_env` が `Some(sock)` なら 5 つの VIBE_TEAM_* を注入し SOCKET にそのパスを渡す
    /// (team セッションを模す)。`None` なら 5 つの env を全て除去 (standalone タブを模す)。
    fn run_bridge(input: &str, team_env: Option<&std::path::Path>) -> Option<Vec<Value>> {
        if Command::new("node").arg("--version").output().is_err() {
            return None;
        }

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "vibe-team-bridge-test-{}-{nonce}.js",
            std::process::id()
        ));
        std::fs::write(&path, SOURCE).expect("write bridge source");

        let mut cmd = Command::new("node");
        cmd.arg(&path);
        match team_env {
            Some(sock) => {
                cmd.env("VIBE_TEAM_SOCKET", sock)
                    .env("VIBE_TEAM_TOKEN", "test-token")
                    .env("VIBE_TEAM_ID", "test-team")
                    .env("VIBE_TEAM_ROLE", "leader")
                    .env("VIBE_AGENT_ID", "vc-test");
            }
            None => {
                cmd.env_remove("VIBE_TEAM_SOCKET")
                    .env_remove("VIBE_TEAM_TOKEN")
                    .env_remove("VIBE_TEAM_ID")
                    .env_remove("VIBE_TEAM_ROLE")
                    .env_remove("VIBE_AGENT_ID");
            }
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn bridge");

        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(input.as_bytes())
            .expect("write stdin");
        drop(child.stdin.take());

        let output = child.wait_with_output().expect("wait bridge");
        let _ = std::fs::remove_file(path);
        assert!(
            output.status.success(),
            "bridge failed: status={:?}, stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
        Some(
            stdout
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str::<Value>(line).expect("json line"))
                .collect(),
        )
    }

    /// 存在しない socket パス (= dead hub) を生成する。connect は ENOENT で失敗し続ける。
    fn dead_hub_sock() -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "vibe-team-deadhub-{}-{nonce}.sock",
            std::process::id()
        ))
    }

    fn run_bridge_without_team_env(input: &str) -> Option<Vec<Value>> {
        run_bridge(input, None)
    }

    /// Issue #1080: env は注入されているが Hub socket が dead (= 到達不能) な team エージェントを模す。
    fn run_bridge_with_dead_hub(input: &str) -> Option<Vec<Value>> {
        run_bridge(input, Some(&dead_hub_sock()))
    }

    #[test]
    fn dead_hub_answers_handshake_locally_without_blocking_initialize() {
        // Issue #1080: env 有 + Hub socket dead でも、initialize と tools/list はローカル即答され、
        // client の startup が 30s timeout しないこと。tools/call は Hub 依存なので pendingOut に
        // 積まれたまま (dead hub では flush されない) 応答が返らないこと。
        let Some(responses) = run_bridge_with_dead_hub(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"team_info","arguments":{}}}
"#,
        ) else {
            return;
        };

        let ids: Vec<i64> = responses.iter().filter_map(|r| r["id"].as_i64()).collect();
        assert!(
            ids.contains(&1),
            "initialize must be answered locally even with a dead hub: {responses:?}"
        );
        assert!(
            ids.contains(&2),
            "tools/list must be answered locally even with a dead hub: {responses:?}"
        );
        assert!(
            !ids.contains(&3),
            "tools/call must NOT be answered while the hub is unreachable (it is queued): {responses:?}"
        );

        let init = responses.iter().find(|r| r["id"] == 1).expect("initialize response");
        assert!(
            init.get("result").is_some() && init.get("error").is_none(),
            "initialize must be a success result, not an error: {init:?}"
        );
        let list = responses.iter().find(|r| r["id"] == 2).expect("tools/list response");
        assert_eq!(
            list["result"]["tools"].as_array().expect("tools array").len(),
            0,
            "tools/list must be empty while disconnected from the hub: {list:?}"
        );
    }

    #[test]
    fn missing_env_still_allows_mcp_initialize_and_empty_tools_list() {
        let Some(responses) = run_bridge_without_team_env(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
"#,
        ) else {
            return;
        };

        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], 1);
        assert!(responses[0].get("result").is_some(), "{:?}", responses[0]);
        assert_eq!(responses[1]["id"], 2);
        assert_eq!(responses[1]["result"]["tools"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn missing_env_tools_call_is_tool_error_not_startup_failure() {
        let Some(responses) = run_bridge_without_team_env(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"team_info","arguments":{}}}
"#,
        ) else {
            return;
        };

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0]["id"], 3);
        assert_eq!(responses[0]["error"]["code"], -32001);
        assert!(responses[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not a vibe-team session"));
    }
}
