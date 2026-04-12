import { useEffect, useState } from 'react';

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
  exitMs = 220
): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'open' | 'closed'>(open ? 'open' : 'closed');

  useEffect(() => {
    if (open) {
      setMounted(true);
      // 2 フレーム待って state を open に切り替えることで
      // "初期スタイル → open スタイル" の transition を確実に発火させる
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setState('open'));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setState('closed');
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  return { mounted, state };
}
