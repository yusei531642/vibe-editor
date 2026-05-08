import type { TerminalAgent } from '../../../types/shared';

type ClaudeCheckState = 'checking' | 'ok' | 'missing';

export function shouldShowGlobalClaudeCheck(
  terminalCount: number,
  claudeState: ClaudeCheckState
): boolean {
  return terminalCount === 0 && claudeState !== 'ok';
}

export function canRenderTerminalForAgent(
  agent: TerminalAgent,
  claudeState: ClaudeCheckState
): boolean {
  if (agent === 'claude') return claudeState === 'ok';
  return true;
}
