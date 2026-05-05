import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * Issue #128: Rust 側 fs_watch が emit する `project:files-changed` を購読し、
 * 渡された callback を呼ぶ汎用フック。Canvas 系カード (ChangesCard / DiffCard /
 * CanvasSidebar) が個別に listen を書く重複を解消する。
 *
 * 連続した change を 250ms debounce してから 1 回だけ callback を呼ぶ。
 */
export function useFilesChanged(callback: () => void, debounceMs = 250): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let timer: number | null = null;

    void (async () => {
      const u = await listen<string>('project:files-changed', () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          cbRef.current();
        }, debounceMs);
      });
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [debounceMs]);
}
