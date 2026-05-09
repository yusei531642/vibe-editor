import { describe, expect, it } from 'vitest';
import { APP_SETTINGS_SCHEMA_VERSION } from '../../../../types/shared';
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
      statusMascotVariant: 'mono'
    });

    expect(migrated.statusMascotVariant).toBe('mono');
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

      expect(migrated.customAgents?.[0]?.args).toBe('--model opus --yes');
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
});
