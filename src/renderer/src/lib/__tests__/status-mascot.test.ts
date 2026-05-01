import { describe, expect, it } from 'vitest';
import { getStatusMascotState, type StatusMascotSnapshot } from '../status-mascot';

const base: StatusMascotSnapshot = {
  viewMode: 'ide',
  activeFilePath: null,
  activeEditorDirty: false,
  hasActiveDiff: false,
  gitChangeCount: 0,
  terminals: []
};

describe('getStatusMascotState', () => {
  it('uses idle when nothing is active', () => {
    expect(getStatusMascotState(base)).toBe('idle');
  });

  it('uses editing when an editor tab is active', () => {
    expect(getStatusMascotState({ ...base, activeFilePath: 'src/App.tsx' })).toBe(
      'editing'
    );
  });

  it('prioritizes dirty work over reviewing and editing', () => {
    expect(
      getStatusMascotState({
        ...base,
        activeFilePath: 'src/App.tsx',
        hasActiveDiff: true,
        gitChangeCount: 1
      })
    ).toBe('dirty');
  });

  it('uses reviewing for diff or canvas mode', () => {
    expect(getStatusMascotState({ ...base, hasActiveDiff: true })).toBe('reviewing');
    expect(getStatusMascotState({ ...base, viewMode: 'canvas' })).toBe('reviewing');
  });

  it('prioritizes terminal activity over dirty work', () => {
    expect(
      getStatusMascotState({
        ...base,
        gitChangeCount: 2,
        terminals: [{ status: '', exited: false, hasActivity: true }]
      })
    ).toBe('running');
  });

  it('prioritizes blocked terminal state over every other state', () => {
    expect(
      getStatusMascotState({
        ...base,
        gitChangeCount: 2,
        terminals: [
          { status: '起動失敗: command not found', exited: false, hasActivity: true }
        ]
      })
    ).toBe('blocked');
  });
});
