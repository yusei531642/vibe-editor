/**
 * use-hmr-recover の単体テスト。
 *
 * Issue #495: PR #489 で `use-pty-session.ts` から切り出された HMR 用キャッシュ群の
 * 振る舞いを固定する。`import.meta.hot` が無い (= 本番ビルド相当の) 経路では
 * すべての関数が安全に no-op になり、世代番号は常に 1 を返すことを検証する。
 *
 * `getHmrPtyCache()` は `import.meta.hot` を直接読むため、テスト環境でも `undefined`
 * となり、本ファイルでは「dev でのキャッシュ動作」までは検証できない。代わりに
 * 「sessionKey が無い経路」「dev cache 不在経路」「acquire/upsert/get/delete の 1 ラウンド」
 * を最小限の表面 API で押さえる。
 */
import { describe, it, expect } from 'vitest';
import {
  acquireGeneration,
  cacheDelete,
  cacheGet,
  cacheUpsert,
  hmrDisposeArmed,
  isCurrentGeneration
} from '../use-hmr-recover';

describe('use-hmr-recover (production-mode behaviour)', () => {
  it('acquireGeneration は sessionKey 未指定なら常に 1 を返す', () => {
    expect(acquireGeneration(undefined)).toBe(1);
    expect(acquireGeneration('')).toBe(1);
  });

  it('isCurrentGeneration は sessionKey 無し / cache 無しでは常に true', () => {
    expect(isCurrentGeneration(undefined, 1)).toBe(true);
    expect(isCurrentGeneration(undefined, 999)).toBe(true);
  });

  it('production 経路 (cache=null) では isCurrentGeneration が常に true', () => {
    // import.meta.hot は test 環境では undefined。よって getHmrPtyCache() は null を返し、
    // 世代比較は実質スキップされ「常に current」とみなされる。
    expect(isCurrentGeneration('canvas-term:abc', 1)).toBe(true);
    expect(isCurrentGeneration('canvas-term:abc', 42)).toBe(true);
  });

  it('cacheUpsert / cacheDelete / cacheGet は cache=null でも例外を投げない', () => {
    // 本番ビルド経路は no-op。例外を吐かずに静かに何もしないことが「壊れていない」の条件。
    expect(() => cacheUpsert('canvas-term:noop', 'pty-1', 1)).not.toThrow();
    expect(() => cacheDelete('canvas-term:noop')).not.toThrow();
    // sessionKey 未指定はガードで早期 return する経路 (line 98 / 105 / 113)。
    expect(() => cacheUpsert(undefined, 'pty-x', 1)).not.toThrow();
    expect(() => cacheDelete(undefined)).not.toThrow();
    expect(cacheGet(undefined)).toBeUndefined();
  });

  it('cacheGet は production 経路 (cache=null) で undefined を返す', () => {
    // production / vitest 環境のどちらでも cache が無いケース。
    expect(cacheGet('canvas-term:nonexistent')).toBeUndefined();
  });

  it('hmrDisposeArmed は { current: boolean } 形状で書き換え可能', () => {
    // useEffect cleanup が読み書きする module-scoped flag。
    // production では常に false のままで kill 経路に入るが、
    // テストでは値が読み書きできることだけ確認する (副作用は無い)。
    const original = hmrDisposeArmed.current;
    try {
      hmrDisposeArmed.current = true;
      expect(hmrDisposeArmed.current).toBe(true);
      hmrDisposeArmed.current = false;
      expect(hmrDisposeArmed.current).toBe(false);
    } finally {
      hmrDisposeArmed.current = original;
    }
  });
});
