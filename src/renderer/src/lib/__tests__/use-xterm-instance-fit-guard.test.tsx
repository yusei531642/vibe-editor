import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useXtermInstance } from '../use-xterm-instance';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../types/shared';

const xtermMocks = vi.hoisted(() => ({
  fitInstances: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
  terminalInstances: [] as Array<{
    options: Record<string, unknown>;
    rows: number;
    cols: number;
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    attachCustomWheelEventHandler: ReturnType<typeof vi.fn>;
    buffer: { active: { type: string; baseY: number } };
    scrollLines: ReturnType<typeof vi.fn>;
  }>
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function TerminalMock(options: Record<string, unknown>) {
    const term = {
      options: { ...options },
      rows: 24,
      cols: 80,
      open: vi.fn(),
      loadAddon: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
      attachCustomWheelEventHandler: vi.fn(),
      buffer: { active: { type: 'normal', baseY: 0 } },
      scrollLines: vi.fn()
    };
    xtermMocks.terminalInstances.push(term);
    return term;
  })
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddonMock() {
    const fit = { fit: vi.fn() };
    xtermMocks.fitInstances.push(fit);
    return fit;
  })
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddonMock() {
    return {
      onContextLoss: vi.fn(),
      dispose: vi.fn(),
      clearTextureAtlas: vi.fn()
    };
  })
}));

function Harness({
  settings,
  disableWebgl
}: {
  settings: AppSettings;
  disableWebgl: boolean;
}) {
  const { containerRef } = useXtermInstance(settings, disableWebgl);
  return <div ref={containerRef} data-testid="xterm-container" />;
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    terminalFontFamily: 'JetBrains Mono Variable',
    editorFontFamily: 'Geist Mono',
    terminalFontSize: 13,
    ...overrides
  };
}

describe('useXtermInstance settings fit guard (Issue #897)', () => {
  let originalFontsDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    xtermMocks.fitInstances.length = 0;
    xtermMocks.terminalInstances.length = 0;
    originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: undefined
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalFontsDescriptor) {
      Object.defineProperty(document, 'fonts', originalFontsDescriptor);
    } else {
      delete (document as Document & { fonts?: FontFaceSet }).fonts;
    }
    vi.restoreAllMocks();
  });

  it('Canvas モードではフォント変更 effect の rAF で FitAddon.fit を呼ばない', async () => {
    const initial = makeSettings();
    const { rerender } = render(<Harness settings={initial} disableWebgl />);

    await waitFor(() => expect(xtermMocks.fitInstances).toHaveLength(1));
    const fit = xtermMocks.fitInstances[0];
    expect(fit.fit).not.toHaveBeenCalled();

    rerender(
      <Harness
        settings={makeSettings({ terminalFontSize: initial.terminalFontSize + 1 })}
        disableWebgl
      />
    );

    expect(fit.fit).not.toHaveBeenCalled();
  });

  it('IDE モードでは従来どおりフォント変更 effect で FitAddon.fit を呼ぶ', async () => {
    const initial = makeSettings();
    const { rerender } = render(<Harness settings={initial} disableWebgl={false} />);

    await waitFor(() => expect(xtermMocks.fitInstances).toHaveLength(1));
    const fit = xtermMocks.fitInstances[0];
    fit.fit.mockClear();

    rerender(
      <Harness
        settings={makeSettings({ terminalFontSize: initial.terminalFontSize + 1 })}
        disableWebgl={false}
      />
    );

    expect(fit.fit).toHaveBeenCalledTimes(1);
  });
});
