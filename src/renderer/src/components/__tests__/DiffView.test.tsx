import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DiffView } from '../DiffView';
import { SettingsProvider } from '../../lib/settings-context';
import { DEFAULT_SETTINGS, type GitDiffResult } from '../../../../types/shared';

vi.mock('../../lib/monaco-setup', () => ({}));

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: () => <div data-testid="diff-editor" />
}));

function installApi(): void {
  window.api = {
    ...window.api,
    settings: {
      ...window.api?.settings,
      load: vi.fn(async () => ({ ...DEFAULT_SETTINGS, language: 'en' })),
      save: vi.fn(async () => undefined),
      pickCustomMascot: vi.fn(async () => null),
      loadCustomMascot: vi.fn(async () => null),
      clearCustomMascot: vi.fn(async () => undefined)
    },
    app: {
      ...window.api?.app,
      setZoomLevel: vi.fn(async () => undefined)
    }
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}

function renderDiffView(
  props: Partial<Parameters<typeof DiffView>[0]> = {}
) {
  return render(
    <Wrapper>
      <DiffView
        result={props.result ?? null}
        loading={props.loading ?? false}
        sideBySide={props.sideBySide ?? true}
        onToggleSideBySide={props.onToggleSideBySide ?? vi.fn()}
      />
    </Wrapper>
  );
}

function diffResult(overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return {
    ok: true,
    path: 'src/example.ts',
    isNew: false,
    isDeleted: false,
    isBinary: false,
    original: 'old',
    modified: 'new',
    ...overrides
  };
}

describe('DiffView i18n', () => {
  let originalApi: typeof window.api | undefined;

  beforeEach(() => {
    originalApi = window.api;
    installApi();
  });

  afterEach(() => {
    cleanup();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      window.api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('loading / empty / error / binary states use the active locale (Issue #844)', async () => {
    const { rerender } = renderDiffView({ loading: true });
    expect(await screen.findByText('Loading diff…')).toBeInTheDocument();

    rerender(
      <Wrapper>
        <DiffView result={null} loading={false} sideBySide onToggleSideBySide={vi.fn()} />
      </Wrapper>
    );
    expect(await screen.findByText('Select a file to view its diff')).toBeInTheDocument();

    rerender(
      <Wrapper>
        <DiffView
          result={diffResult({ ok: false, error: 'boom' })}
          loading={false}
          sideBySide
          onToggleSideBySide={vi.fn()}
        />
      </Wrapper>
    );
    expect(await screen.findByText('Error: boom')).toBeInTheDocument();

    rerender(
      <Wrapper>
        <DiffView
          result={diffResult({ isBinary: true, path: 'asset.png' })}
          loading={false}
          sideBySide
          onToggleSideBySide={vi.fn()}
        />
      </Wrapper>
    );
    expect(
      await screen.findByText('Binary files cannot be shown as diffs: asset.png')
    ).toBeInTheDocument();
  });

  it('header status and toggle labels use the active locale', async () => {
    renderDiffView({ result: diffResult({ isNew: true }), sideBySide: true });

    expect(await screen.findByText('src/example.ts (new)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle diff display mode' })).toHaveAttribute(
      'title',
      'Switch to inline'
    );
  });
});
