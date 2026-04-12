#!/usr/bin/env node
/**
 * Team Communication MCP Server for vive-editor
 *
 * Each Claude Code / Codex instance spawns this MCP server.
 * The server identifies itself via environment variables:
 *   VIVE_TEAM_ID     - team identifier
 *   VIVE_TEAM_ROLE   - this agent's role (leader, programmer, etc.)
 *   VIVE_AGENT_ID    - unique agent instance id
 *   VIVE_TEAM_FILE   - path to shared team state JSON file
 *
 * Communication is done via a shared JSON file that all agents read/write.
 */

const fs = require('fs');
const path = require('path');

// ---------- Config from env ----------
const TEAM_ID = process.env.VIVE_TEAM_ID || '';
const ROLE = process.env.VIVE_TEAM_ROLE || 'unknown';
const AGENT_ID = process.env.VIVE_AGENT_ID || '0';
const TEAM_FILE = process.env.VIVE_TEAM_FILE || '';

if (!TEAM_ID || !TEAM_FILE) {
  // Not running in a team context - still start but provide no tools
}

// ---------- Shared state file I/O ----------

function readState() {
  try {
    if (!TEAM_FILE) return { team: null, members: [], messages: [] };
    const raw = fs.readFileSync(TEAM_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { team: { id: TEAM_ID, name: '' }, members: [], messages: [] };
  }
}

function writeState(state) {
  if (!TEAM_FILE) return;
  const dir = path.dirname(TEAM_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  fs.writeFileSync(TEAM_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function ensureRegistered() {
  const state = readState();
  const exists = state.members.find(m => m.agentId === AGENT_ID);
  if (!exists) {
    state.members.push({
      agentId: AGENT_ID,
      role: ROLE,
      status: 'active',
      joinedAt: new Date().toISOString()
    });
    writeState(state);
  }
}

// ---------- Tool implementations ----------

function teamSend(args) {
  const { to, message } = args;
  if (!to || !message) return { error: 'to and message are required' };

  const state = readState();
  const msg = {
    id: (state.messages.length + 1),
    from: ROLE,
    fromAgentId: AGENT_ID,
    to: to,  // role name or "all"
    message: message,
    timestamp: new Date().toISOString(),
    readBy: [AGENT_ID]
  };
  state.messages.push(msg);
  writeState(state);
  return { success: true, messageId: msg.id };
}

function teamRead(args) {
  const state = readState();
  const unreadOnly = args?.unread_only !== false;

  const relevant = state.messages.filter(m => {
    // Messages addressed to this agent's role or "all"
    const isForMe = m.to === 'all' || m.to === ROLE;
    // Exclude own messages
    const notFromMe = m.fromAgentId !== AGENT_ID;
    if (!isForMe || !notFromMe) return false;
    if (unreadOnly && m.readBy && m.readBy.includes(AGENT_ID)) return false;
    return true;
  });

  // Mark as read
  if (relevant.length > 0) {
    for (const m of relevant) {
      const stateMsg = state.messages.find(sm => sm.id === m.id);
      if (stateMsg && (!stateMsg.readBy || !stateMsg.readBy.includes(AGENT_ID))) {
        if (!stateMsg.readBy) stateMsg.readBy = [];
        stateMsg.readBy.push(AGENT_ID);
      }
    }
    writeState(state);
  }

  return {
    messages: relevant.map(m => ({
      id: m.id,
      from: m.from,
      message: m.message,
      timestamp: m.timestamp
    })),
    count: relevant.length
  };
}

function teamInfo() {
  const state = readState();
  return {
    teamId: state.team?.id || TEAM_ID,
    teamName: state.team?.name || '',
    myRole: ROLE,
    myAgentId: AGENT_ID,
    members: (state.members || []).map(m => ({
      role: m.role,
      agentId: m.agentId,
      status: m.status
    }))
  };
}

function teamUpdateStatus(args) {
  const { status } = args;
  if (!status) return { error: 'status is required' };

  const state = readState();
  const member = state.members.find(m => m.agentId === AGENT_ID);
  if (member) {
    member.status = status;
    writeState(state);
  }
  return { success: true };
}

function teamGetTasks() {
  const state = readState();
  return {
    tasks: (state.tasks || []).map(t => ({
      id: t.id,
      assignedTo: t.assignedTo,
      description: t.description,
      status: t.status,
      createdBy: t.createdBy,
      createdAt: t.createdAt
    }))
  };
}

function teamAssignTask(args) {
  const { assignee, description } = args;
  if (!assignee || !description) return { error: 'assignee and description are required' };

  const state = readState();
  if (!state.tasks) state.tasks = [];
  const task = {
    id: state.tasks.length + 1,
    assignedTo: assignee,
    description: description,
    status: 'pending',
    createdBy: ROLE,
    createdAt: new Date().toISOString()
  };
  state.tasks.push(task);

  // Also send a message notification
  state.messages.push({
    id: state.messages.length + 1,
    from: ROLE,
    fromAgentId: AGENT_ID,
    to: assignee,
    message: `[Task #${task.id}] ${description}`,
    timestamp: new Date().toISOString(),
    readBy: [AGENT_ID]
  });

  writeState(state);
  return { success: true, taskId: task.id };
}

function teamUpdateTask(args) {
  const { task_id, status } = args;
  if (!task_id || !status) return { error: 'task_id and status are required' };

  const state = readState();
  const task = (state.tasks || []).find(t => t.id === task_id);
  if (!task) return { error: `Task #${task_id} not found` };

  task.status = status;
  writeState(state);
  return { success: true };
}

// ---------- MCP Protocol ----------

const TOOLS = [
  {
    name: 'team_send',
    description: 'Send a message to a team member by role (e.g., "leader", "programmer") or "all" for broadcast. Use this to coordinate work, report progress, or ask questions.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target role (leader/planner/programmer/researcher/reviewer) or "all"' },
        message: { type: 'string', description: 'Message content' }
      },
      required: ['to', 'message']
    }
  },
  {
    name: 'team_read',
    description: 'Read messages from other team members addressed to you. Call this periodically to check for new instructions or updates.',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only return unread messages (default: true)', default: true }
      }
    }
  },
  {
    name: 'team_info',
    description: 'Get information about the team: members, roles, and their current status.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'team_status',
    description: 'Update your current status so other team members know what you are working on.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Your current status (e.g., "implementing auth module", "done", "reviewing PR")' }
      },
      required: ['status']
    }
  },
  {
    name: 'team_assign_task',
    description: 'Assign a task to a team member by role. Mainly used by the leader to delegate work.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Role to assign the task to' },
        description: { type: 'string', description: 'Task description' }
      },
      required: ['assignee', 'description']
    }
  },
  {
    name: 'team_get_tasks',
    description: 'Get all tasks assigned in this team, including their status.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'team_update_task',
    description: 'Update the status of a task (e.g., "in_progress", "done", "blocked").',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        status: { type: 'string', description: 'New status' }
      },
      required: ['task_id', 'status']
    }
  }
];

const TOOL_HANDLERS = {
  team_send: teamSend,
  team_read: teamRead,
  team_info: teamInfo,
  team_status: teamUpdateStatus,
  team_assign_task: teamAssignTask,
  team_get_tasks: teamGetTasks,
  team_update_task: teamUpdateTask
};

function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      // Register this agent in the shared state
      if (TEAM_ID && TEAM_FILE) ensureRegistered();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'vive-team',
            version: '1.0.0'
          }
        }
      };

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // No response needed for notifications
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: (TEAM_ID && TEAM_FILE) ? TOOLS : []
        }
      };

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const handler = TOOL_HANDLERS[toolName];

      if (!handler) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
            isError: true
          }
        };
      }

      try {
        const result = handler(toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }
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
      // Unknown method - return error for requests (those with id)
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
      }
      return null;
  }
}

// ---------- stdio transport (newline-delimited JSON) ----------

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // Process all complete lines (each line = one JSON-RPC message)
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.substring(0, newlineIndex).replace(/\r$/, '');
    buffer = buffer.substring(newlineIndex + 1);
    if (!line) continue;

    try {
      const request = JSON.parse(line);
      const response = handleRequest(request);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      const errResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      };
      process.stdout.write(JSON.stringify(errResponse) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
