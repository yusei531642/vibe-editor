/**
 * Issue #578: hidden 中に複数件の `team:recruit-request` を受けても、
 * 可視化遷移時に 1 回だけ Toast が表示されることを固定する。
 *
 * - `@tauri-apps/api/event.listen` をモックして手動で payload を発火する
 * - `useCanvasStore` / `useRoleProfiles` / `recruit-ack` / `tauri-api` の team-state IPC を
 *   stub し、recruit handler の async 経路 (requester not found) は早期 return させる。
 * - visibility は singleton state を直接 toggle して観測する。
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from 'vitest';
import type { ReactNode } from 'react';

import { ToastProvider } from '../toast-context';

// ----- Mocks -----

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  recruitObserved: vi.fn().mockResolvedValue(undefined),
  ackRecruit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (event: string, cb: (e: { payload: unknown }) => void) => {
      mocks.listeners.set(event, cb);
      return () => mocks.listeners.delete(event);
    }
  )
}));

vi.mock('../subscribe-event', () => ({
  // ToastProvider が `team:role-lint-warning` 等を購読しに来るが、テストでは無視。
  subscribeEvent: vi.fn(() => () => {})
}));

vi.mock('../recruit-ack', () => ({
  ackRecruit: (...args: unknown[]) => mocks.ackRecruit(...args)
}));

vi.mock('../tauri-api', () => ({
  api: {
    teamState: {
      recruitObservedWhileHidden: (...args: unknown[]) =>
        mocks.recruitObserved(...args)
    }
  }
}));

// canvas store: requester がいない状態で固定 → recruit handler の async 経路は
// `requester_not_found` で早期 return する。Toast 集計に必要な hidden カウントは
// その前段で行われるため、テストの観測点は変わらない。
vi.mock('../../stores/canvas', () => ({
  useCanvasStore: Object.assign(
    () => ({ nodes: [] }),
    {
      getState: () => ({
        nodes: [],
        addCard: vi.fn(),
        notifyRecruit: vi.fn()
      })
    }
  )
}));

vi.mock('../role-profiles-context', () => ({
  useRoleProfiles: () => ({ registerDynamicRole: vi.fn() })
}));

// 最小 i18n: 表示用にキー + パラメータ値を結合して返し、テストで count を文字列照合できるようにする。
vi.mock('../i18n', () => ({
  useT:
    () =>
    (key: string, params?: Record<string, string | number>): string => {
      if (!params) return key;
      const tail = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `${key}|${tail}`;
    }
}));

// 上のモックがすべて hoist された後で対象 hook を import する。
import { useRecruitListener } from '../use-recruit-listener';
import { __resetCanvasVisibilityForTests } from '../use-canvas-visibility';

function Harness({ children }: { children?: ReactNode }): JSX.Element {
  useRecruitListener();
  return <>{children}</>;
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function emitRecruit(newAgentId: string): void {
  const cb = mocks.listeners.get('team:recruit-request');
  if (!cb) throw new Error('team:recruit-request listener not registered yet');
  cb({
    payload: {
      teamId: 'team-1',
      requesterAgentId: 'requester-x',
      requesterRole: 'leader',
      newAgentId,
      roleProfileId: 'worker',
      engine: 'claude'
    }
  });
}

describe('useRecruitListener — hidden recruit aggregation (Issue #578)', () => {
  beforeEach(() => {
    __resetCanvasVisibilityForTests();
    mocks.listeners.clear();
    mocks.recruitObserved.mockClear();
    mocks.ackRecruit.mockClear();
    setVisibility('visible');
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true
    });
  });

  afterEach(() => {
    cleanup();
    __resetCanvasVisibilityForTests();
    vi.clearAllMocks();
  });

  it('hidden 中に 3 件の recruit が来ても、可視化時に Toast は 1 回だけ表示される', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(mocks.listeners.get('team:recruit-request')).toBeTruthy();
    });

    // Canvas を hidden にしてから recruit を 3 件発火
    act(() => setVisibility('hidden'));
    await act(async () => {
      emitRecruit('agent-a');
      emitRecruit('agent-b');
      emitRecruit('agent-c');
    });

    // hidden 中は Toast は表示されない
    expect(document.querySelectorAll('.toast--warning').length).toBe(0);

    // 可視化遷移で 1 件だけ警告 Toast が出る (mock i18n は `key|count=N` 形式)
    act(() => setVisibility('visible'));
    await waitFor(() => {
      const warnings = document.querySelectorAll('.toast--warning');
      expect(warnings.length).toBe(1);
      expect(warnings[0].textContent).toContain('count=3');
    });

    // 同じ visible のまま再度 visibilitychange を撒いても増えない (edge trigger)
    act(() => setVisibility('visible'));
    expect(document.querySelectorAll('.toast--warning').length).toBe(1);
  });

  it('visible 中の recruit は Toast を出さない (Canvas を見ているのでユーザに気付きが要らない)', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );
    await waitFor(() => expect(mocks.listeners.get('team:recruit-request')).toBeTruthy());

    await act(async () => {
      emitRecruit('agent-a');
      emitRecruit('agent-b');
    });

    expect(document.querySelectorAll('.toast--warning').length).toBe(0);
  });

  it('hidden 経過時間が threshold 未満なら recruit_observed_while_hidden IPC を呼ばない', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );
    await waitFor(() => expect(mocks.listeners.get('team:recruit-request')).toBeTruthy());

    act(() => setVisibility('hidden'));
    await act(async () => emitRecruit('agent-a'));

    // hidden になった直後 (= 0ms 経過) なので IPC は呼ばれない
    expect(mocks.recruitObserved).not.toHaveBeenCalled();
  });

  it('hidden 経過時間が threshold 以上なら recruit_observed_while_hidden IPC を呼ぶ', async () => {
    // Date.now() だけスタブする (vi.useFakeTimers は waitFor の内部 setTimeout を止めて
    // テストが timeout するため使わない)。
    let mockNow = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    try {
      render(
        <ToastProvider>
          <Harness />
        </ToastProvider>
      );
      await waitFor(() =>
        expect(mocks.listeners.get('team:recruit-request')).toBeTruthy()
      );

      act(() => setVisibility('hidden')); // hiddenSinceMs = 1_700_000_000_000
      mockNow += 6000;                   // threshold 5000ms を超える経過時間
      await act(async () => emitRecruit('agent-a'));

      expect(mocks.recruitObserved).toHaveBeenCalledTimes(1);
      const arg = (mocks.recruitObserved as Mock).mock.calls[0]![0] as {
        teamId: string;
        agentId: string;
        hiddenForMs: number;
      };
      expect(arg.teamId).toBe('team-1');
      expect(arg.agentId).toBe('agent-a');
      expect(arg.hiddenForMs).toBeGreaterThanOrEqual(5000);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
