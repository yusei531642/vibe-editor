import { describe, it, expect } from 'vitest';
import {
  customAgentToProfile,
  customAgentIdFromRole,
  CUSTOM_AGENT_ROLE_PREFIX
} from '../role-profiles-context';
import type { AgentConfig } from '../../../../types/shared';

describe('custom agent → role profile synthesis (Issue #1021)', () => {
  it('synthesizes an API agent into a role profile', () => {
    const agent = {
      id: 'gpt5',
      name: 'GPT-5',
      runtime: 'api',
      providerId: 'openai',
      model: 'gpt-5'
    } as AgentConfig;
    const p = customAgentToProfile(agent);
    expect(p.id).toBe('custom:gpt5');
    expect(p.source).toBe('user');
    expect(p.i18n.en.label).toBe('GPT-5');
    expect(p.i18n.en.description).toContain('openai');
    expect(p.i18n.en.description).toContain('gpt-5');
    // custom agent は recruit/dismiss 権限を持たない
    expect(p.permissions.canRecruit).toBe(false);
    expect(p.permissions.canDismiss).toBe(false);
  });

  it('synthesizes a CLI agent and shows its command', () => {
    const agent = {
      id: 'aider',
      name: 'Aider',
      runtime: 'cli',
      command: 'aider',
      args: '',
      cwd: ''
    } as AgentConfig;
    const p = customAgentToProfile(agent);
    expect(p.id).toBe('custom:aider');
    expect(p.i18n.en.label).toBe('Aider');
    expect(p.i18n.en.description).toContain('aider');
  });

  it('falls back to id when name is empty', () => {
    const agent = {
      id: 'x1',
      name: '',
      runtime: 'cli',
      command: 'foo',
      args: '',
      cwd: ''
    } as AgentConfig;
    expect(customAgentToProfile(agent).i18n.en.label).toBe('x1');
  });

  it('round-trips the agent id from the role id', () => {
    expect(CUSTOM_AGENT_ROLE_PREFIX).toBe('custom:');
    expect(customAgentIdFromRole('custom:gpt5')).toBe('gpt5');
    expect(customAgentIdFromRole('custom:aider')).toBe('aider');
    // 非 custom role は null
    expect(customAgentIdFromRole('leader')).toBeNull();
    expect(customAgentIdFromRole('hr')).toBeNull();
  });
});
