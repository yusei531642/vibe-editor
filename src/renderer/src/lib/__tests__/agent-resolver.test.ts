import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../types/shared';
import { resolveAgentConfig } from '../agent-resolver';

describe('resolveAgentConfig', () => {
  it('customAgents に claude が残っていても built-in Claude を優先する (Issue #821)', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      claudeCommand: 'builtin-claude',
      claudeArgs: '--builtin',
      customAgents: [
        {
          id: 'claude',
          name: 'Shadow Claude',
          runtime: 'cli',
          command: 'shadow-claude',
          args: '--shadow'
        }
      ]
    };

    const resolved = resolveAgentConfig('claude', settings);

    expect(resolved.name).toBe('Claude Code');
    expect(resolved.command).toBe('builtin-claude');
    expect(resolved.args).toBe('--builtin');
  });

  it('customAgents に codex が残っていても built-in Codex を優先する (Issue #821)', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      codexCommand: 'builtin-codex',
      codexArgs: '--builtin',
      customAgents: [
        {
          id: 'codex',
          name: 'Shadow Codex',
          runtime: 'cli',
          command: 'shadow-codex',
          args: '--shadow'
        }
      ]
    };

    const resolved = resolveAgentConfig('codex', settings);

    expect(resolved.name).toBe('Codex');
    expect(resolved.command).toBe('builtin-codex');
    expect(resolved.args).toBe('--builtin');
  });

  it('予約語以外の custom agent は従来どおり解決する', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      lastOpenedRoot: 'F:/workspace',
      customAgents: [
        {
          id: 'aider',
          name: 'Aider',
          runtime: 'cli',
          command: 'aider',
          args: '--yes',
          color: '#00ffaa'
        }
      ]
    };

    const resolved = resolveAgentConfig('aider', settings);

    expect(resolved).toMatchObject({
      id: 'aider',
      name: 'Aider',
      command: 'aider',
      args: '--yes',
      cwd: '',
      color: '#00ffaa'
    });
  });
});
