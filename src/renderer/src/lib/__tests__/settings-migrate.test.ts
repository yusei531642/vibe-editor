import { describe, expect, it } from 'vitest';
import { APP_SETTINGS_SCHEMA_VERSION, DEFAULT_SETTINGS } from '../../../../types/shared';
import { migrateSettings } from '../settings-migrate';

describe('migrateSettings', () => {
  it('adds the default status mascot variant for older settings', () => {
    const migrated = migrateSettings({
      schemaVersion: 8,
      language: 'ja',
      theme: 'claude-dark'
    });

    expect(migrated.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    expect(migrated.statusMascotVariant).toBe('vibe');
  });

  it('keeps a valid status mascot variant', () => {
    const migrated = migrateSettings({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      language: 'ja',
      theme: 'claude-dark',
      statusMascotVariant: 'coder'
    });

    expect(migrated.statusMascotVariant).toBe('coder');
  });

  it('replaces an invalid status mascot variant with the default', () => {
    const migrated = migrateSettings({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      language: 'ja',
      theme: 'claude-dark',
      statusMascotVariant: 'unknown'
    });

    expect(migrated.statusMascotVariant).toBe('vibe');
  });

  // ---------- Issue #836: schemaVersion >= 1 でも theme / language を毎ロード検証 ----------
  describe('theme / language validation (Issue #836)', () => {
    it('current schema でも未知 theme / language を default に戻す', () => {
      const migrated = migrateSettings({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        language: 'xx',
        theme: 'removed-theme'
      });

      expect(migrated.language).toBe(DEFAULT_SETTINGS.language);
      expect(migrated.theme).toBe(DEFAULT_SETTINGS.theme);
    });

    it('current schema の有効な theme / language は維持する', () => {
      const migrated = migrateSettings({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        language: 'en',
        theme: 'glass'
      });

      expect(migrated.language).toBe('en');
      expect(migrated.theme).toBe('glass');
    });
  });

  // ---------- Issue #821: customAgents.id の built-in 予約語衝突を修復 ----------
  describe('custom agent reserved id migration (Issue #821)', () => {
    it('claude / codex と衝突する customAgents.id を user namespace に改名する', () => {
      const migrated = migrateSettings({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        language: 'ja',
        theme: 'claude-dark',
        customAgents: [
          { id: 'claude', name: 'Shadow Claude', command: 'shadow', args: '' },
          { id: 'codex', name: 'Shadow Codex', command: 'shadow', args: '' },
          { id: 'aider', name: 'Aider', command: 'aider', args: '' }
        ]
      });

      expect(migrated.customAgents?.map((agent) => agent.id)).toEqual([
        '_user_claude',
        '_user_codex',
        'aider'
      ]);
    });

    it('改名先が既に存在する場合は suffix を付けて重複を避ける', () => {
      const migrated = migrateSettings({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        language: 'ja',
        theme: 'claude-dark',
        customAgents: [
          { id: '_user_claude', name: 'Existing', command: 'existing', args: '' },
          { id: 'claude', name: 'Shadow Claude', command: 'shadow', args: '' }
        ]
      });

      expect(migrated.customAgents?.map((agent) => agent.id)).toEqual([
        '_user_claude',
        '_user_claude_2'
      ]);
    });
  });

  // ---------- Issue #449: v9 → v10 Unicode dash 正規化 ----------
  describe('v9 → v10 Unicode dash normalization (Issue #449)', () => {
    it('normalizes leading Unicode dash in codexArgs to ASCII "--"', () => {
      const migrated = migrateSettings({
        schemaVersion: 9,
        language: 'ja',
        theme: 'claude-dark',
        codexArgs: '–dangerously-bypass-approvals-and-sandbox'
      });

      expect(migrated.codexArgs).toBe('--dangerously-bypass-approvals-and-sandbox');
      expect(migrated.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    });

    it('normalizes leading Unicode dash in claudeArgs', () => {
      const migrated = migrateSettings({
        schemaVersion: 9,
        language: 'ja',
        theme: 'claude-dark',
        claudeArgs: '–model opus'
      });

      expect(migrated.claudeArgs).toBe('--model opus');
    });

    it('normalizes Unicode dash in customAgents[].args', () => {
      const migrated = migrateSettings({
        schemaVersion: 9,
        language: 'ja',
        theme: 'claude-dark',
        customAgents: [
          {
            id: 'aider',
            name: 'Aider',
            command: 'aider',
            args: '–model opus ––yes'
          }
        ]
      });

      const agent = migrated.customAgents?.[0];
      expect(agent).toMatchObject({ runtime: 'cli' });
      expect(agent?.runtime === 'cli' ? agent.args : undefined).toBe('--model opus --yes');
    });

    it('leaves ASCII-only args strings unchanged', () => {
      const migrated = migrateSettings({
        schemaVersion: 9,
        language: 'ja',
        theme: 'claude-dark',
        claudeArgs: '--foo bar',
        codexArgs: '--baz'
      });

      expect(migrated.claudeArgs).toBe('--foo bar');
      expect(migrated.codexArgs).toBe('--baz');
    });

    it('does not run normalization when schemaVersion is already 10', () => {
      // v10 以降の設定では migration は走らないため、Unicode dash を含んでいても
      // そのまま保持される (ユーザーが UI で自分で直す or runtime parseShellArgs が救済する)
      const migrated = migrateSettings({
        schemaVersion: 10,
        language: 'ja',
        theme: 'claude-dark',
        codexArgs: '–foo'
      });

      expect(migrated.codexArgs).toBe('–foo');
    });
  });

  // ---------- Issue #618: v10 → v11 terminalForceUtf8 default ----------
  describe('v10 → v11 terminalForceUtf8 default (Issue #618)', () => {
    it('inserts terminalForceUtf8 = true for legacy v10 settings', () => {
      const migrated = migrateSettings({
        schemaVersion: 10,
        language: 'ja',
        theme: 'claude-dark'
      });

      expect(migrated.terminalForceUtf8).toBe(true);
      expect(migrated.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    });

    it('inserts terminalForceUtf8 = true even for very old v0 settings', () => {
      // v0 (= schemaVersion 未定義) でも shallow merge 後に true が入ること。
      const migrated = migrateSettings({
        language: 'en',
        theme: 'dark'
      });

      expect(migrated.terminalForceUtf8).toBe(true);
    });

    it('preserves an explicit false from the user', () => {
      // ユーザーが OEM コードページを意図的に維持したくて false を保存しているケース。
      const migrated = migrateSettings({
        schemaVersion: 11,
        language: 'ja',
        theme: 'claude-dark',
        terminalForceUtf8: false
      });

      expect(migrated.terminalForceUtf8).toBe(false);
    });

    it('preserves an explicit false set on legacy v10 (re-migration)', () => {
      // v10 のうちに先行で false が書き込まれていたら、v10 → v11 migration はそれを尊重する。
      const migrated = migrateSettings({
        schemaVersion: 10,
        language: 'ja',
        theme: 'claude-dark',
        terminalForceUtf8: false
      });

      expect(migrated.terminalForceUtf8).toBe(false);
    });

    it('coerces non-boolean values to true (default)', () => {
      // 型壊れ (string や null) はサポート外なので default に戻す。
      const migrated = migrateSettings({
        schemaVersion: 10,
        language: 'ja',
        theme: 'claude-dark',
        terminalForceUtf8: 'yes' as unknown as boolean
      });

      expect(migrated.terminalForceUtf8).toBe(true);
    });
  });

  describe('v11 → v12 custom agent runtime migration (Issue #994)', () => {
    it('marks legacy customAgents as CLI runtime', () => {
      const migrated = migrateSettings({
        schemaVersion: 11,
        language: 'ja',
        theme: 'claude-dark',
        customAgents: [
          { id: 'aider', name: 'Aider', command: 'aider', args: '--yes' }
        ]
      });

      expect(migrated.customAgents?.[0]).toMatchObject({
        id: 'aider',
        runtime: 'cli',
        command: 'aider',
        args: '--yes'
      });
      expect(migrated.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    });

    it('keeps API agents and sanitizes skillIds', () => {
      const migrated = migrateSettings({
        schemaVersion: 12,
        language: 'ja',
        theme: 'claude-dark',
        customAgents: [
          {
            id: 'openrouter-worker',
            name: 'OpenRouter Worker',
            runtime: 'api',
            providerId: 'openrouter',
            model: 'openai/gpt-4.1',
            skillIds: ['vibe-team', 1]
          }
        ]
      });

      expect(migrated.customAgents?.[0]).toMatchObject({
        runtime: 'api',
        providerId: 'openrouter',
        model: 'openai/gpt-4.1',
        skillIds: ['vibe-team']
      });
    });
  });
});
