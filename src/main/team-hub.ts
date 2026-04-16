import { app } from 'electron';
import { createServer, type Server, type Socket } from 'net';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { agentSessions, sessions } from './lib/session-registry';

/**
 * TeamHub — メインプロセス内でホストするチーム連携用 JSON-RPC サーバー。
 *
 * 各 Claude Code / Codex プロセスに spawn される team-bridge.js が
 * stdio MCP と TCP JSON-RPC を橋渡しする。Hub は bridge から届くツール呼び出しを
 * 処理し、team_send で宛先の pty に直接 pty.write() で注入する。
 *
 * これによりファイルベースのポーリング通信を廃し、メッセージがリアルタイムで
 * 相手 CLI のプロンプトへ到達する。
 */

interface TeamMessage {
  id: number;
  from: string;
  fromAgentId: string;
  to: string;
  message: string;
  timestamp: string;
  readBy: string[];
}

interface TeamTask {
  id: number;
  assignedTo: string;
  description: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

interface TeamInfo {
  id: string;
  name: string;
  messages: TeamMessage[];
  tasks: TeamTask[];
}

const teams = new Map<string, TeamInfo>();
/**
 * 現在 "アクティブ" とみなす teamId 集合。`registerTeam` で追加、
 * `clearTeam` で削除する。renderer 側の setup/cleanup と対応し、
 * MCP 設定の参照カウントとして機能する(空になるまで claude.json の
 * `vive-team` エントリを消さない)。
 */
const activeTeamIds = new Set<string>();

function getOrCreateTeam(teamId: string): TeamInfo {
  let t = teams.get(teamId);
  if (!t) {
    t = { id: teamId, name: '', messages: [], tasks: [] };
    teams.set(teamId, t);
  }
  return t;
}

function updateTeamName(teamId: string, name: string): void {
  if (!teamId || teamId === '_init') return;
  const team = getOrCreateTeam(teamId);
  if (name) {
    team.name = name;
  }
}

/**
 * 各 agentId に対して送信中のチャンクタイマーを保持する。
 * agent セッションが unregister されたら cancelInjectTimers(agentId) で全キャンセル。
 * これにより pty が kill された後も空 write を続けてしまう問題を防ぐ。
 */
const pendingInjectTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

export function cancelInjectTimers(agentId: string): void {
  const timers = pendingInjectTimers.get(agentId);
  if (!timers) return;
  for (const t of timers) clearTimeout(t);
  pendingInjectTimers.delete(agentId);
}

function trackTimer(agentId: string, timer: ReturnType<typeof setTimeout>): void {
  let set = pendingInjectTimers.get(agentId);
  if (!set) {
    set = new Set();
    pendingInjectTimers.set(agentId, set);
  }
  set.add(timer);
}

function untrackTimer(agentId: string, timer: ReturnType<typeof setTimeout>): void {
  const set = pendingInjectTimers.get(agentId);
  if (!set) return;
  set.delete(timer);
  if (set.size === 0) pendingInjectTimers.delete(agentId);
}

/**
 * pty へメッセージを直接注入する。Claude Code/Codex のプロンプトに「入力」として届く。
 *
 * ConPTY (Windows の node-pty) の stdin バッファは小さく、一度に長文を write すると
 * 途中で欠落するため、UTF-8 バイトベースで 64B チャンクに分割して ~15ms 間隔で流す。
 * 最後に \r を送って Claude Code に送信させる。
 *
 * 全チャンクタイマーは pendingInjectTimers に登録し、agent が消えたら cancelInjectTimers で一括解除。
 */
/**
 * 1 エージェントあたりで保持を許容するチャンクタイマー数の上限。
 * これを超えるような高速な team_send 連打が発生すると、前回の注入が
 * 終わる前に次が被さり、最後の Enter が正しい順で届かなくなる。
 * 上限に達したら新規注入を拒否してレート制限する(安全サイド倒し)。
 */
const MAX_PENDING_INJECT_TIMERS_PER_AGENT = 256;

function injectIntoPty(agentId: string, fromRole: string, text: string): boolean {
  const session = agentSessions.get(agentId);
  if (!session) return false;
  // PTY 側が直前に死んでいても agentSessions に一瞬残っているケースがあるので、
  // sessions 側のハードな生存状態もチェック(二重の安全装置)。
  if (!session.pty) return false;
  // 高負荷時の上限チェック
  const current = pendingInjectTimers.get(agentId)?.size ?? 0;
  if (current >= MAX_PENDING_INJECT_TIMERS_PER_AGENT) {
    return false;
  }
  const banner = `[Team ← ${fromRole}] `;
  // 改行は1行に整形（ブラケットペーストは Claude Code では送信不可のため）
  const flat = text.replace(/\n{2,}/g, ' | ').replace(/\n/g, ' ');
  // 過大な注入を避けるため、1 メッセージ 4 KB で切り詰める
  const MAX_PAYLOAD = 4096;
  const truncated =
    flat.length > MAX_PAYLOAD ? flat.slice(0, MAX_PAYLOAD) + ' …(truncated)' : flat;
  const payload = banner + truncated;

  // バイト長で分割しないとマルチバイト文字の途中で切れる可能性があるので、
  // Buffer で一旦変換してから UTF-8 として安全な境界を探す。
  const bytes = Buffer.from(payload, 'utf-8');
  if (bytes.length === 0) return false;
  const CHUNK_SIZE = 64;
  const CHUNK_DELAY_MS = 15;

  const chunks: Buffer[] = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + CHUNK_SIZE, bytes.length);
    // UTF-8 マルチバイト途中で切らないよう後退: 0b10xxxxxx が先頭なら戻る
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(i, end));
    i = end;
  }

  // 書き込み先セッションが途中で死んでも、残りタイマーが "別のエージェント" に
  // 化けた同じ agentId に書き込んでしまわないよう、必ず同じ session オブジェクトを
  // 参照して送る(agentSessions.get(agentId) === session のチェックで担保)。
  const writeIfSame = (data: string): void => {
    if (agentSessions.get(agentId) !== session) return;
    if (!sessions.has(findSessionIdByPty(session))) return;
    try {
      session.pty.write(data);
    } catch {
      /* 既に破棄されている */
    }
  };

  try {
    // 最初のチャンクは即時書き込み、以降は少しずつ遅延
    writeIfSame(chunks[0].toString('utf-8'));
    for (let k = 1; k < chunks.length; k++) {
      const chunk = chunks[k];
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        untrackTimer(agentId, timer);
        writeIfSame(chunk.toString('utf-8'));
      }, k * CHUNK_DELAY_MS);
      trackTimer(agentId, timer);
    }
    // 全チャンク送信完了後に Enter を送る
    const enterTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      untrackTimer(agentId, enterTimer);
      writeIfSame('\r');
    }, chunks.length * CHUNK_DELAY_MS);
    trackTimer(agentId, enterTimer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Session オブジェクトから現在の sessions テーブルでの id を逆引きする。
 * O(n) だがセッション数は多くて十数個程度なので実害はない。
 * 見つからなければ空文字を返し、呼び出し側は `sessions.has('')` が false に
 * なることを期待して送信を諦める。
 */
function findSessionIdByPty(session: { pty: unknown }): string {
  for (const [id, s] of sessions) {
    if (s === session) return id;
  }
  return '';
}

// ---------- ツール実装 ----------

interface CallContext {
  teamId: string;
  role: string;
  agentId: string;
}

function teamSend(ctx: CallContext, args: Record<string, unknown>): unknown {
  const to = String(args.to ?? '');
  const message = String(args.message ?? '');
  if (!to || !message) return { error: 'to and message are required' };

  const team = getOrCreateTeam(ctx.teamId);
  const msg: TeamMessage = {
    id: team.messages.length + 1,
    from: ctx.role,
    fromAgentId: ctx.agentId,
    to,
    message,
    timestamp: new Date().toISOString(),
    readBy: [ctx.agentId]
  };
  team.messages.push(msg);

  // 宛先の ptyId を解決して直接注入
  const delivered: string[] = [];
  for (const [aid, session] of agentSessions) {
    if (aid === ctx.agentId) continue; // 自分には送らない
    if (session.teamId !== ctx.teamId) continue;
    const targetRole = session.role ?? '';
    if (to === 'all' || to === targetRole) {
      if (injectIntoPty(aid, ctx.role, message)) {
        delivered.push(targetRole || aid);
        msg.readBy.push(aid);
      }
    }
  }

  return {
    success: true,
    messageId: msg.id,
    delivered,
    note:
      delivered.length === 0
        ? '宛先のエージェントが見つからないか、現在オンラインではありません。'
        : `${delivered.length} 名に直接配信しました。`
  };
}

function teamRead(ctx: CallContext, args: Record<string, unknown>): unknown {
  const team = getOrCreateTeam(ctx.teamId);
  const unreadOnly = args.unread_only !== false;

  const relevant = team.messages.filter((m) => {
    const isForMe = m.to === 'all' || m.to === ctx.role;
    const notFromMe = m.fromAgentId !== ctx.agentId;
    if (!isForMe || !notFromMe) return false;
    if (unreadOnly && m.readBy.includes(ctx.agentId)) return false;
    return true;
  });

  for (const m of relevant) {
    if (!m.readBy.includes(ctx.agentId)) m.readBy.push(ctx.agentId);
  }

  return {
    messages: relevant.map((m) => ({
      id: m.id,
      from: m.from,
      message: m.message,
      timestamp: m.timestamp
    })),
    count: relevant.length
  };
}

function teamInfo(ctx: CallContext): unknown {
  const team = getOrCreateTeam(ctx.teamId);
  const members: { role: string; agentId: string; online: boolean }[] = [];
  for (const [aid, session] of agentSessions) {
    if (session.teamId !== ctx.teamId) continue;
    members.push({
      role: session.role ?? 'unknown',
      agentId: aid,
      online: true
    });
  }
  // Hub に未登録なメンバーも messages の from から推定できるが割愛
  return {
    teamId: team.id,
    teamName: team.name,
    myRole: ctx.role,
    myAgentId: ctx.agentId,
    members
  };
}

function teamStatus(): unknown {
  // ステータス更新は UI 上の意味しか持たないので成功応答のみ
  return { success: true };
}

function teamAssignTask(ctx: CallContext, args: Record<string, unknown>): unknown {
  const assignee = String(args.assignee ?? '');
  const description = String(args.description ?? '');
  if (!assignee || !description) return { error: 'assignee and description are required' };

  const team = getOrCreateTeam(ctx.teamId);
  const task: TeamTask = {
    id: team.tasks.length + 1,
    assignedTo: assignee,
    description,
    status: 'pending',
    createdBy: ctx.role,
    createdAt: new Date().toISOString()
  };
  team.tasks.push(task);

  // 通知を team_send と同じ経路で投げる
  teamSend(ctx, {
    to: assignee,
    message: `[Task #${task.id}] ${description}`
  });

  return { success: true, taskId: task.id };
}

function teamGetTasks(ctx: CallContext): unknown {
  const team = getOrCreateTeam(ctx.teamId);
  return { tasks: team.tasks };
}

function teamUpdateTask(ctx: CallContext, args: Record<string, unknown>): unknown {
  const team = getOrCreateTeam(ctx.teamId);
  const taskId = Number(args.task_id);
  const status = String(args.status ?? '');
  const task = team.tasks.find((t) => t.id === taskId);
  if (!task) return { error: `Task #${taskId} not found` };
  task.status = status;
  return { success: true };
}

const TOOL_DEFS = [
  {
    name: 'team_send',
    description:
      'Send a message directly into another team member\'s terminal. Specify the target role ("leader", "programmer", etc.) or "all" for broadcast. The message is injected into the target Claude/Codex prompt in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target role (leader/planner/programmer/researcher/reviewer) or "all"'
        },
        message: { type: 'string', description: 'Message content' }
      },
      required: ['to', 'message']
    }
  },
  {
    name: 'team_read',
    description:
      'Read past messages addressed to you. Usually not needed because team_send injects directly, but useful for reviewing history.',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'team_info',
    description: 'Get the current team roster and your identity.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'team_status',
    description: 'Report your current status (informational).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status']
    }
  },
  {
    name: 'team_assign_task',
    description: 'Assign a task to a role. Sends a notification to the target immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['assignee', 'description']
    }
  },
  {
    name: 'team_get_tasks',
    description: 'List all tasks in the team.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'team_update_task',
    description: 'Update the status of a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        status: { type: 'string' }
      },
      required: ['task_id', 'status']
    }
  }
];

type ToolHandler = (ctx: CallContext, args: Record<string, unknown>) => unknown;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  team_send: teamSend,
  team_read: teamRead,
  team_info: teamInfo,
  team_status: teamStatus,
  team_assign_task: teamAssignTask,
  team_get_tasks: teamGetTasks,
  team_update_task: teamUpdateTask
};

// ---------- JSON-RPC サーバー ----------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function handleMcpRequest(ctx: CallContext, req: JsonRpcRequest): unknown {
  const { method, params, id } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vive-team', version: '2.0.0' }
        }
      };

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: ctx.teamId ? TOOL_DEFS : [] }
      };

    case 'tools/call': {
      const toolName = String(params?.name ?? '');
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }
            ],
            isError: true
          }
        };
      }
      try {
        const result = handler(ctx, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
            isError: true
          }
        };
      }
    }

    default:
      if (id !== undefined && id !== null) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
      }
      return null;
  }
}

// ---------- ハンドシェイク付き TCP 接続処理 ----------

interface ClientState {
  authed: boolean;
  ctx: CallContext | null;
  buffer: string;
}

const BRIDGE_SOURCE = `#!/usr/bin/env node
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
  process.stderr.write('[team-bridge] missing VIVE_TEAM_SOCKET or VIVE_TEAM_TOKEN\\n');
  // それでも JSON-RPC は最低限喋れる必要があるので、空ツールのスタブで応答する
}

const [host, portStr] = SOCKET.split(':');
const port = parseInt(portStr || '0', 10);

let socket = null;
let connected = false;
let reconnectTimer = null;
const pendingOut = [];

function connect() {
  socket = net.createConnection({ host: host || '127.0.0.1', port }, () => {
    // ハンドシェイク: token/teamId/role/agentId を1行で送る
    const hello = JSON.stringify({ token: TOKEN, teamId: TEAM_ID, role: ROLE, agentId: AGENT_ID });
    socket.write(hello + '\\n');
    connected = true;
    for (const line of pendingOut) socket.write(line);
    pendingOut.length = 0;
  });

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) process.stdout.write(line + '\\n');
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

// stdio → TCP
let stdinBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\\n')) !== -1) {
    const line = stdinBuf.slice(0, nl).replace(/\\r$/, '');
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;

    // Hub が未接続 or 未設定の場合は最低限のローカル応答で返す
    if (!connected || !SOCKET || !TOKEN) {
      try {
        const req = JSON.parse(line);
        const resp = localFallback(req);
        if (resp) process.stdout.write(JSON.stringify(resp) + '\\n');
      } catch {}
      if (connected) {
        pendingOut.push(line + '\\n');
      }
      continue;
    }
    socket.write(line + '\\n');
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
`;

class TeamHub {
  private server: Server | null = null;
  private _port = 0;
  private _token = '';
  private _bridgePath = '';
  private clients = new Set<Socket>();

  get port(): number {
    return this._port;
  }
  get token(): string {
    return this._token;
  }
  get bridgePath(): string {
    return this._bridgePath;
  }
  get socketAddress(): string {
    return `127.0.0.1:${this._port}`;
  }
  get isRunning(): boolean {
    return this.server !== null && this._port > 0;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this._token = randomBytes(24).toString('hex');

    // bridge スクリプトを userData 配下に書き出し（バージョン固定の内容）
    const userData = app.getPath('userData');
    await fs.mkdir(userData, { recursive: true });
    this._bridgePath = join(userData, 'team-bridge.js');
    await fs.writeFile(this._bridgePath, BRIDGE_SOURCE, 'utf-8');

    this.server = createServer((socket) => this.handleClient(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve();
      });
    });
  }

  stop(): void {
    for (const socket of this.clients) {
      try { socket.destroy(); } catch { /* noop */ }
    }
    this.clients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* noop */
      }
      this.server = null;
    }
    this._port = 0;
  }

  /** terminal.ts 側から pty の agentId/role を更新したいとき用（未使用） */
  notifyAgentSpawned(_agentId: string, _role: string): void {
    /* TeamHub は agentSessions を直接参照するだけなので特にやることなし */
  }

  /**
   * チーム破棄時に履歴と参照カウントをクリーンアップ。
   * @returns `true` ならこれでアクティブチームが 0 になったので、
   *          呼び出し側は MCP 設定も実際に削除してよい。
   */
  clearTeam(teamId: string): boolean {
    teams.delete(teamId);
    activeTeamIds.delete(teamId);
    return activeTeamIds.size === 0;
  }

  registerTeam(teamId: string, name: string): void {
    if (teamId && teamId !== '_init') {
      activeTeamIds.add(teamId);
    }
    updateTeamName(teamId, name);
  }

  /** 現在アクティブなチーム数。参照カウント用 */
  get activeTeamCount(): number {
    return activeTeamIds.size;
  }

  private handleClient(socket: Socket): void {
    this.clients.add(socket);
    socket.on('close', () => { this.clients.delete(socket); });

    const state: ClientState = { authed: false, ctx: null, buffer: '' };
    socket.setEncoding('utf-8');

    socket.on('data', (chunk: Buffer | string) => {
      state.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let nl;
      while ((nl = state.buffer.indexOf('\n')) !== -1) {
        const line = state.buffer.slice(0, nl).replace(/\r$/, '');
        state.buffer = state.buffer.slice(nl + 1);
        if (!line) continue;

        if (!state.authed) {
          try {
            const hello = JSON.parse(line) as {
              token?: string;
              teamId?: string;
              role?: string;
              agentId?: string;
            };
            if (hello.token !== this._token) {
              socket.destroy();
              return;
            }
            state.authed = true;
            state.ctx = {
              teamId: hello.teamId || '',
              role: hello.role || 'unknown',
              agentId: hello.agentId || ''
            };
          } catch {
            socket.destroy();
            return;
          }
          continue;
        }

        try {
          const req = JSON.parse(line) as JsonRpcRequest;
          const resp = handleMcpRequest(state.ctx!, req);
          if (resp) socket.write(JSON.stringify(resp) + '\n');
        } catch {
          const errResp = {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' }
          };
          socket.write(JSON.stringify(errResp) + '\n');
        }
      }
    });

    socket.on('error', () => {
      /* クライアント切断は無視 */
    });
  }

  /** 既存セッションから sessions/agentSessions を空にする補助（テスト用） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _debugFlush(): void {
    sessions.clear();
    agentSessions.clear();
  }
}

export const teamHub = new TeamHub();
