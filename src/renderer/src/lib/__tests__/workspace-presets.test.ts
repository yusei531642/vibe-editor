import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  expandPresetOrganizations,
  GAP,
  presetMemberCount,
  presetOrganizationCount,
  presetPosition
} from '../workspace-presets';
import { NODE_H, NODE_W } from '../../stores/canvas';

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

  // Issue #442: presetPosition のピッチは実カードサイズ NODE_W/NODE_H に追随する。
  // 旧定数 (CARD_W=480 / CARD_H=340) のままだと 640x400 のカードが重なる。
  it('presetPosition uses NODE_W/NODE_H pitch (Issue #442)', () => {
    const a = presetPosition(0, 0);
    const b = presetPosition(1, 0);
    const c = presetPosition(0, 1);
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b.x - a.x).toBe(NODE_W + GAP);
    expect(c.y - a.y).toBe(NODE_H + GAP);
    // 隣接セルの dx は必ず NODE_W 以上 (= カード同士が重ならない)
    expect(b.x - a.x).toBeGreaterThanOrEqual(NODE_W);
    expect(c.y - a.y).toBeGreaterThanOrEqual(NODE_H);
  });
});
