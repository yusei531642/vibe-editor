import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TeamPreset } from '../../../../../types/shared';
import { BUILTIN_PRESETS } from '../../../lib/workspace-presets';
import { BuiltinPresetItem, SavedPresetItem } from '../CanvasSpawnItems';

describe('CanvasSpawnItems', () => {
  afterEach(cleanup);

  it('組み込みプリセットへ翻訳済みの説明を表示する', () => {
    render(
      <BuiltinPresetItem
        preset={BUILTIN_PRESETS[0]}
        label="Leader only"
        description="Starts with only a Claude Code leader."
        agentCountLabel="1 agent"
        onClick={() => undefined}
      />
    );

    expect(screen.getByText('Starts with only a Claude Code leader.')).toBeInTheDocument();
  });

  it('保存プリセットの自由入力説明をそのまま表示する', () => {
    const preset = {
      id: 'saved',
      name: 'Saved preset',
      description: 'ユーザーが入力した原文',
      roles: [{ roleProfileId: 'leader', agent: 'claude' }]
    } as TeamPreset;

    render(
      <SavedPresetItem
        preset={preset}
        agentCountLabel="1 agent"
        onClick={() => undefined}
      />
    );

    expect(screen.getByText('ユーザーが入力した原文')).toBeInTheDocument();
  });
});
