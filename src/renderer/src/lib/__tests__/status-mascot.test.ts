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
  it('returns idle when nothing is happening', () => {
    expect(getStatusMascotState(base)).toBe('idle');
  });

  it('still returns idle when an editor tab is open (Issue #717: editor state は idle に集約)', () => {
    expect(getStatusMascotState({ ...base, activeFilePath: 'src/App.tsx' })).toBe('idle');
  });

  it('still returns idle for diff / canvas / git changes alone', () => {
    expect(getStatusMascotState({ ...base, hasActiveDiff: true })).toBe('idle');
    expect(getStatusMascotState({ ...base, viewMode: 'canvas' })).toBe('idle');
    expect(getStatusMascotState({ ...base, gitChangeCount: 5 })).toBe('idle');
  });

  it('returns working when a terminal has activity', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [{ status: null, exited: false, hasActivity: true }]
      })
    ).toBe('working');
  });

  it('returns working for starting / reconnect status kind', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [{ status: { kind: 'starting', command: 'claude' }, exited: false, hasActivity: false }]
      })
    ).toBe('working');
    expect(
      getStatusMascotState({
        ...base,
        terminals: [
          { status: { kind: 'reconnecting', command: 'claude' }, exited: false, hasActivity: false }
        ]
      })
    ).toBe('working');
  });

  it('returns thinking when terminal is waiting for response (no activity)', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [
          { status: null, exited: false, hasActivity: false, awaitingResponse: true }
        ]
      })
    ).toBe('thinking');
  });

  it('prioritizes working over thinking', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [
          { status: null, exited: false, hasActivity: true, awaitingResponse: true }
        ]
      })
    ).toBe('working');
  });

  it('returns error when a terminal failed by status kind', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [
          {
            status: { kind: 'spawn_failed', error: 'command not found' },
            exited: false,
            hasActivity: true
          }
        ]
      })
    ).toBe('error');
  });

  it('returns error when a terminal exited even with activity', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [{ status: null, exited: true, hasActivity: true }]
      })
    ).toBe('error');
  });

  it('prioritizes error over working / thinking', () => {
    expect(
      getStatusMascotState({
        ...base,
        terminals: [
          { status: { kind: 'exception', error: 'boom' }, exited: false, hasActivity: true },
          { status: null, exited: false, hasActivity: true, awaitingResponse: true }
        ]
      })
    ).toBe('error');
  });
});
