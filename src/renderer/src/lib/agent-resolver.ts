/**
 * agent-resolver.ts — TerminalAgent 識別子から起動パラメータを解決する窓口。
 *
 * 'claude' / 'codex' は built-in として settings.claudeCommand / codexCommand を参照、
 * それ以外は settings.customAgents から lookup する。
 */
import type { AppSettings, CliAgentConfig } from '../../../types/shared';

export interface ResolvedAgent {
  id: string;
  name: string;
  command: string;
  args: string;
  cwd: string;
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
  if (agentId === 'codex') {
    return {
      id: 'codex',
      name: 'Codex',
      command: settings.codexCommand || 'codex',
      args: settings.codexArgs || '',
      cwd: ''
    };
  }
  if (agentId !== 'claude') {
    const custom = (settings.customAgents ?? []).find(
      (a): a is CliAgentConfig => a.id === agentId && a.runtime === 'cli'
    );
    if (custom) {
      return {
        id: custom.id,
        name: custom.name,
        command: custom.command,
        args: custom.args,
        cwd: '',
        color: custom.color
      };
    }
  }
  // claude (default fallback)
  return {
    id: 'claude',
    name: 'Claude Code',
    command: settings.claudeCommand || 'claude',
    args: settings.claudeArgs || '',
    cwd: ''
  };
}
