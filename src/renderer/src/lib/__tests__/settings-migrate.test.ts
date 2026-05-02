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
});
