/**
 * agent-resolver.ts — TerminalAgent 識別子から起動パラメータを解決する窓口。
 *
 * 'claude' / 'codex' は built-in として settings.claudeCommand / codexCommand を参照、
 * それ以外は settings.customAgents から lookup する。
 */
import type { AppSettings } from '../../../types/shared';

export interface ResolvedAgent {
  id: string;
  name: string;
  command: string;
  args: string;
  cwd: string;
  color?: string;
}

export interface AgentOption {
  value: string;
  label: string;
  color?: string;
}

/**
 * agent id → 起動パラメータを 1 つのオブジェクトで返す。
 * 呼び出し元 (AgentNodeCard 等) はこれだけ読めば PTY spawn に必要な値が揃う。
 */
export function resolveAgentConfig(
  agentId: string,
  settings: AppSettings
): ResolvedAgent {
  const custom = (settings.customAgents ?? []).find((a) => a.id === agentId);
  if (custom) {
    return {
      id: custom.id,
      name: custom.name,
      command: custom.command,
      args: custom.args,
      cwd: custom.cwd || settings.lastOpenedRoot || '',
      color: custom.color
    };
  }
  if (agentId === 'codex') {
    return {
      id: 'codex',
      name: 'Codex',
      command: settings.codexCommand || 'codex',
      args: settings.codexArgs || '',
      cwd: settings.lastOpenedRoot || ''
    };
  }
  // claude (default fallback)
  return {
    id: 'claude',
    name: 'Claude Code',
    command: settings.claudeCommand || 'claude',
    args: settings.claudeArgs || '',
    cwd: settings.claudeCwd || settings.lastOpenedRoot || ''
  };
}

/**
 * Team ビルダーや Canvas の Add Card ポップオーバーなどで
 * 「選択可能なエージェント一覧」を作るためのユーティリティ。
 */
export function allAgentOptions(settings: AppSettings): AgentOption[] {
  return [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    ...(settings.customAgents ?? []).map((a) => ({
      value: a.id,
      label: a.name,
      color: a.color
    }))
  ];
}

/** built-in agent id かどうか (カスタム id の予約語チェックに使う)。 */
export function isBuiltinAgentId(id: string): boolean {
  return id === 'claude' || id === 'codex';
}
