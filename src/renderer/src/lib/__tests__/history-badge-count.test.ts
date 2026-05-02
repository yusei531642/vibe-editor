import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistoryBadgeCount } from '../use-history-badge-count';

describe('useHistoryBadgeCount', () => {
  it('履歴非表示の初回は totalCount をそのままバッジに出す', () => {
    const { result } = renderHook(() => useHistoryBadgeCount(3, false));
    expect(result.current).toBe(3);
  });

  it('履歴表示中はバッジを 0 にする', () => {
    const { result } = renderHook(({ visible }) => useHistoryBadgeCount(3, visible), {
      initialProps: { visible: true }
    });
    expect(result.current).toBe(0);
  });

  it('履歴表示中に件数が増えても 0 のまま追従する', () => {
    const { result, rerender } = renderHook(
      ({ total }) => useHistoryBadgeCount(total, true),
      { initialProps: { total: 2 } }
    );
    expect(result.current).toBe(0);
    rerender({ total: 5 });
    expect(result.current).toBe(0);
  });

  it('履歴を一度開いて閉じてから件数が増えると増分のみ表示する', () => {
    const { result, rerender } = renderHook(
      ({ total, visible }) => useHistoryBadgeCount(total, visible),
      { initialProps: { total: 2, visible: true } }
    );
    expect(result.current).toBe(0);

    act(() => {
      rerender({ total: 2, visible: false });
    });
    expect(result.current).toBe(0);

    act(() => {
      rerender({ total: 5, visible: false });
    });
    expect(result.current).toBe(3);
  });

  it('閉じたあと件数が減っても 0 に clamp する', () => {
    const { result, rerender } = renderHook(
      ({ total, visible }) => useHistoryBadgeCount(total, visible),
      { initialProps: { total: 4, visible: true } }
    );
    expect(result.current).toBe(0);

    act(() => {
      rerender({ total: 4, visible: false });
    });
    expect(result.current).toBe(0);

    act(() => {
      rerender({ total: 1, visible: false });
    });
    expect(result.current).toBe(0);
  });

  it('閉じた状態で件数が増えてから開くとバッジが消える', () => {
    const { result, rerender } = renderHook(
      ({ total, visible }) => useHistoryBadgeCount(total, visible),
      { initialProps: { total: 3, visible: false } }
    );
    expect(result.current).toBe(3);

    act(() => {
      rerender({ total: 3, visible: true });
    });
    expect(result.current).toBe(0);
  });
});
