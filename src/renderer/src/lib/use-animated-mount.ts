import { useEffect, useState } from 'react';

export type AnimatedMountPreset = 'spring' | 'fade' | 'scale';

export interface AnimatedMountOptions {
  exitMs?: number;
  preset?: AnimatedMountPreset;
}

export interface AnimatedMountResult {
  mounted: boolean;
  state: 'open' | 'closed';
  dataState: 'opening' | 'open' | 'closing' | 'closed';
  motion: AnimatedMountPreset;
}

/**
 * モーダル等の enter / exit アニメーションを扱う共通フック。
 *
 * `open` が true に変わったら即座にマウントし、1 フレーム後に
 * `state` を "open" に切り替えることで CSS transition を発火させる。
 * `open` が false に戻ったら `state` を "closed" に切り替え、
 * `exitMs` 後に実際にアンマウント(`mounted = false`)する。
 *
 * 呼び出し側は `if (!mounted) return null;` で描画を抑制し、
 * ラッパ要素に `data-state={state}` を付けて CSS で transition する。
 */
export function useAnimatedMount(
  open: boolean,
  options: number | AnimatedMountOptions = 160
): AnimatedMountResult {
  return useDataState(open, options);
}

export function useDataState(
  open: boolean,
  options: number | AnimatedMountOptions = 160
): AnimatedMountResult {
  const normalized =
    typeof options === 'number' ? { exitMs: options } : options;
  const motion = normalized.preset ?? 'spring';
  const exitMs =
    normalized.exitMs ?? (motion === 'fade' ? 140 : 160);
  const [mounted, setMounted] = useState(open);
  const [dataState, setDataState] = useState<'opening' | 'open' | 'closing' | 'closed'>(
    open ? 'open' : 'closed'
  );

  useEffect(() => {
    if (open) {
      setMounted(true);
      setDataState('opening');
      // 2 フレーム待って state を open に切り替えることで
      // "初期スタイル → open スタイル" の transition を確実に発火させる
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setDataState('open'));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    if (!mounted) {
      setDataState('closed');
      return undefined;
    }
    setDataState('closing');
    const t = setTimeout(() => {
      setMounted(false);
      setDataState('closed');
    }, exitMs);
    return () => clearTimeout(t);
  }, [mounted, open, exitMs]);

  return {
    mounted,
    state: dataState === 'opening' || dataState === 'open' ? 'open' : 'closed',
    dataState,
    motion
  };
}

export function useSpringMount(open: boolean, exitMs = 160): AnimatedMountResult {
  return useAnimatedMount(open, { exitMs, preset: 'spring' });
}

export function useFadeMount(open: boolean, exitMs = 160): AnimatedMountResult {
  return useAnimatedMount(open, { exitMs, preset: 'fade' });
}

export function useScaleMount(open: boolean, exitMs = 160): AnimatedMountResult {
  return useAnimatedMount(open, { exitMs, preset: 'scale' });
}
