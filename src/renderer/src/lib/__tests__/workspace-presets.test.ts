import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  expandPresetOrganizations,
  presetMemberCount,
  presetOrganizationCount
} from '../workspace-presets';

const t = (key: string): string => key;

describe('workspace presets', () => {
  it('expands Issue #370 dual organization presets as independent organizations', () => {
    const dualPresets = BUILTIN_PRESETS.filter((preset) => preset.id.startsWith('dual-'));

    expect(dualPresets.map((preset) => preset.id)).toEqual([
      'dual-claude-claude',
      'dual-claude-codex',
      'dual-codex-codex',
      'dual-codex-claude'
    ]);

    for (const preset of dualPresets) {
      expect(presetOrganizationCount(preset)).toBe(2);
      expect(presetMemberCount(preset)).toBe(2);
      const organizations = expandPresetOrganizations(preset, t, preset.i18nKey);
      expect(organizations).toHaveLength(2);
      expect(organizations[0].meta.color).not.toBe(organizations[1].meta.color);
      expect(organizations.every((org) => org.members[0]?.role === 'leader')).toBe(true);
    }
  });

  it('keeps legacy single-team presets compatible', () => {
    const preset = BUILTIN_PRESETS.find((item) => item.id === 'leader-codex');
    expect(preset).toBeDefined();
    const organizations = expandPresetOrganizations(preset!, t, preset!.i18nKey);

    expect(presetOrganizationCount(preset!)).toBe(1);
    expect(presetMemberCount(preset!)).toBe(1);
    expect(organizations).toHaveLength(1);
    expect(organizations[0].members[0]?.agent).toBe('codex');
  });
});
