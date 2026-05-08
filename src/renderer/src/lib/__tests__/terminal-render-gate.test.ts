import { describe, expect, it } from 'vitest';

import {
  canRenderTerminalForAgent,
  shouldShowGlobalClaudeCheck
} from '../terminal-render-gate';

describe('terminal-render-gate', () => {
  it('shows the global Claude check only before a terminal is opened', () => {
    expect(shouldShowGlobalClaudeCheck(0, 'missing')).toBe(true);
    expect(shouldShowGlobalClaudeCheck(1, 'missing')).toBe(false);
    expect(shouldShowGlobalClaudeCheck(0, 'ok')).toBe(false);
  });

  it('does not block Codex terminals when Claude is missing', () => {
    expect(canRenderTerminalForAgent('codex', 'missing')).toBe(true);
    expect(canRenderTerminalForAgent('claude', 'missing')).toBe(false);
  });
});
