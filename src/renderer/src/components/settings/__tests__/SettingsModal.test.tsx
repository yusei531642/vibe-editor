/**
 * SettingsModal の section nav + apply / reset の振る舞いテスト。
 *
 * Issue #495: PR #491 の settings 整理を踏まえ、modal の以下を固定する。
 *   1. open=true で「設定」見出しと General セクション (Language / Density) が描画される
 *   2. Density のラジオを切り替えると Apply 押下時に onApply に新しい draft が渡る
 *   3. Apply 押下から 380ms 後に onClose が呼ばれる (saved → close 遷移)
 *   4. Reset ボタンは draft を DEFAULT_SETTINGS に戻すが、永続化は行わない
 *      (= onApply 未押下なので外部 onApply は呼ばれない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsModal } from '../../SettingsModal';
import { SettingsProvider } from '../../../lib/settings-context';
import { ToastProvider } from '../../../lib/toast-context';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../../types/shared';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function installApi(): void {
  (window as TestWindow).api = {
    settings: {
      load: vi.fn(async () => DEFAULT_SETTINGS),
      save: vi.fn(async () => undefined)
    },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined)
    }
  };
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <ToastProvider>{children}</ToastProvider>
    </SettingsProvider>
  );
}

describe('SettingsModal', () => {
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    installApi();
    vi.useFakeTimers();
    // useSpringMount / RAF が動かないと mounted が反転しないため即時実行に。
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as unknown as typeof requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('open=true で General セクションが描画される', async () => {
    render(
      <Wrapper>
        <SettingsModal
          open
          initial={DEFAULT_SETTINGS}
          onApply={vi.fn()}
          onClose={vi.fn()}
        />
      </Wrapper>
    );

    // useSpringMount の "opening" → "open" 切替を 1 tick 進める
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // dialog role が present
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // General セクションには Language / Density 見出しが含まれる (デフォルト activeSection='general')
    expect(screen.getByText('言語')).toBeInTheDocument();
    expect(screen.getByText('情報密度')).toBeInTheDocument();
  });

  it('Density 変更 → Apply で onApply が呼ばれ、380ms 後に onClose が呼ばれる', async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <Wrapper>
        <SettingsModal
          open
          initial={DEFAULT_SETTINGS}
          onApply={onApply}
          onClose={onClose}
        />
      </Wrapper>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // density を compact に切り替え (DENSITY_OPTIONS.label は固定 "Compact")
    const compactRadio = screen.getByRole('radio', { name: /Compact/ });
    fireEvent.click(compactRadio);

    // Apply 押下
    const applyBtn = screen.getByRole('button', { name: /適用して保存|Apply & save/ });
    fireEvent.click(applyBtn);

    expect(onApply).toHaveBeenCalledTimes(1);
    const applied = onApply.mock.calls[0][0] as AppSettings;
    expect(applied.density).toBe('compact');

    // close は 380ms タイマー後
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Reset は draft を DEFAULT_SETTINGS に戻すが onApply は呼ばない', async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const initial: AppSettings = { ...DEFAULT_SETTINGS, density: 'comfortable' };

    render(
      <Wrapper>
        <SettingsModal
          open
          initial={initial}
          onApply={onApply}
          onClose={onClose}
        />
      </Wrapper>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // 初期状態は comfortable が選択されている
    const comfortable = screen.getByRole('radio', { name: /Comfortable/ }) as HTMLInputElement;
    expect(comfortable.checked).toBe(true);

    // Reset 押下 → draft が DEFAULT (density='normal') に戻る
    const resetBtn = screen.getByRole('button', { name: /デフォルトに戻す|Reset to defaults/ });
    fireEvent.click(resetBtn);

    const normal = screen.getByRole('radio', { name: /^Normal/ }) as HTMLInputElement;
    expect(normal.checked).toBe(true);

    // onApply / onClose は呼ばれない (Reset は draft 操作のみ)
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
