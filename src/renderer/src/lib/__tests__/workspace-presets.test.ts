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
import { translate } from '../i18n';
import { buildVoiceAvailablePresets } from '../../components/canvas/VoiceControlButton';

const t = (key: string): string => key;

describe('workspace presets', () => {
  // PR #713 (v1.6.0 UI ポリッシュ) で builtin プリセットを Leader-only の
  // 2 つ (leader-claude / leader-codex) に集約し、Issue #370 の dual-* /
  // leader-hr-* マルチ組織プリセットは撤去された。複数組織は Leader の
  // team_recruit で動的に増やす運用に一本化されている。
  it('only ships the Leader-only builtin presets after PR #713 cleanup', () => {
    expect(BUILTIN_PRESETS.map((preset) => preset.id)).toEqual(['leader-claude', 'leader-codex']);
    expect(BUILTIN_PRESETS.some((preset) => preset.id.startsWith('dual-'))).toBe(false);

    for (const preset of BUILTIN_PRESETS) {
      expect(presetOrganizationCount(preset)).toBe(1);
      expect(presetMemberCount(preset)).toBe(1);
      const organizations = expandPresetOrganizations(preset, t, preset.i18nKey);
      expect(organizations).toHaveLength(1);
      expect(organizations[0].members[0]?.role).toBe('leader');
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

  it('組み込み説明と voice metadata を日本語・英語へ切り替える', () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(translate('ja', preset.descriptionI18nKey)).toMatch(/のみで起動/);
      expect(translate('en', preset.descriptionI18nKey)).toMatch(/^Starts with only/);
    }

    expect(buildVoiceAvailablePresets('ja').every((preset) => preset.description.includes('起動')))
      .toBe(true);
    expect(buildVoiceAvailablePresets('en').every((preset) => preset.description.startsWith('Starts')))
      .toBe(true);
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
