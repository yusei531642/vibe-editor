import { describe, it, expect } from 'vitest';
import {
  builtinAgentDescriptors,
  customAgentDescriptor,
  defaultSkillInjectionForEngine,
  engineForAgentConfig,
  listAgentDescriptors,
  resolveAgentDescriptor
} from '../agent-registry';
import { DEFAULT_SETTINGS } from '../../../../types/shared';
import type {
  ApiAgentConfig,
  AppSettings,
  CliAgentConfig
} from '../../../../types/shared';

const cliCodex: CliAgentConfig = {
  id: 'my-cli',
  name: 'My CLI',
  runtime: 'cli',
  command: 'mycli',
  args: '--foo',
  engine: 'codex',
  color: '#abcdef',
  icon: 'Rocket',
  tags: ['exp']
};

const cliPlain: CliAgentConfig = {
  id: 'plain',
  name: 'Plain',
  runtime: 'cli',
  command: 'plain',
  args: ''
};

const apiAgent: ApiAgentConfig = {
  id: 'gpt',
  name: 'GPT',
  runtime: 'api',
  providerId: 'openai',
  model: 'gpt-4',
  skillIds: ['s1']
};

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  customAgents: [cliCodex, cliPlain, apiAgent]
};

describe('agent-registry', () => {
  it('builtin descriptors expose claude/codex with correct engine and skill injection', () => {
    const builtins = builtinAgentDescriptors(settings);
    expect(builtins.map((d) => d.id)).toEqual(['claude', 'codex']);
    const claude = builtins.find((d) => d.id === 'claude')!;
    const codex = builtins.find((d) => d.id === 'codex')!;
    expect(claude.engine).toBe('claude');
    expect(claude.kind).toBe('builtin');
    expect(claude.skillInjection).toBe('claude-dir');
    expect(codex.engine).toBe('codex');
    expect(codex.skillInjection).toBe('prompt-file');
  });

  it('engineForAgentConfig respects cli engine, defaults to claude, treats api as claude', () => {
    expect(engineForAgentConfig(cliCodex)).toBe('codex');
    expect(engineForAgentConfig(cliPlain)).toBe('claude');
    expect(engineForAgentConfig(apiAgent)).toBe('claude');
  });

  it('customAgentDescriptor normalizes a cli agent with explicit engine/icon/color', () => {
    const d = customAgentDescriptor(cliCodex);
    expect(d.kind).toBe('custom');
    expect(d.runtime).toBe('cli');
    expect(d.engine).toBe('codex');
    expect(d.displayName).toBe('My CLI');
    expect(d.icon).toBe('Rocket');
    expect(d.accentColor).toBe('#abcdef');
    expect(d.tags).toEqual(['exp']);
    expect(d.command).toBe('mycli');
    // engine codex かつ skillInjection 未指定 → engine 既定 'prompt-file' (Issue #1125)
    expect(d.skillInjection).toBe('prompt-file');
  });

  it('customAgentDescriptor fills defaults for a plain cli agent', () => {
    const d = customAgentDescriptor(cliPlain);
    expect(d.engine).toBe('claude');
    expect(d.icon).toBe('Terminal');
    expect(d.skillInjection).toBe('claude-dir');
    expect(d.defaultSkillIds).toEqual([]);
  });

  it('customAgentDescriptor normalizes an api agent', () => {
    const d = customAgentDescriptor(apiAgent);
    expect(d.runtime).toBe('api');
    expect(d.engine).toBe('claude');
    expect(d.icon).toBe('Bot');
    expect(d.providerId).toBe('openai');
    expect(d.model).toBe('gpt-4');
    expect(d.defaultSkillIds).toEqual(['s1']);
    expect(d.skillInjection).toBe('none');
  });

  it('defaultSkillInjectionForEngine maps engine to injection default', () => {
    expect(defaultSkillInjectionForEngine('claude')).toBe('claude-dir');
    expect(defaultSkillInjectionForEngine('codex')).toBe('prompt-file');
  });

  it('resolveAgentDescriptor resolves by agentConfigId then engine fallback', () => {
    expect(resolveAgentDescriptor({ agentConfigId: 'my-cli' }, settings).id).toBe('my-cli');
    expect(resolveAgentDescriptor({ engine: 'codex' }, settings).id).toBe('codex');
    // 未指定は claude built-in に解決
    expect(resolveAgentDescriptor({}, settings).id).toBe('claude');
    // 未知の agentConfigId は engine fallback
    expect(resolveAgentDescriptor({ agentConfigId: 'nope', engine: 'codex' }, settings).id).toBe(
      'codex'
    );
  });

  it('listAgentDescriptors concatenates builtins and customs', () => {
    const all = listAgentDescriptors(settings);
    expect(all.map((d) => d.id)).toEqual(['claude', 'codex', 'my-cli', 'plain', 'gpt']);
  });
});
