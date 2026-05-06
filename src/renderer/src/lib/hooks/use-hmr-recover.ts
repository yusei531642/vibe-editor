/**
 * use-hmr-recover — usePtySession の HMR 判定と再接続キャッシュを切り出した
 * モジュール。Vite の `import.meta.hot.dispose` を一度だけ登録し、HMR cleanup と
 * 通常 unmount を区別する。再接続用 ptyId と「世代番号 (二重 listener bind 防止用)」
 * は `import.meta.hot.data` 上にぶら下げ、`use-xterm-bind` から照会される。
 *
 * 以下、Issue #271 (HMR remount で同 PTY へ再 bind) で導入された設計を維持する。
 *   1. `hmrDisposeArmed` フラグ — `dispose(cb)` で「HMR が今この module を捨てる」
 *      シグナルを受けたら true。次の hook mount の effect 冒頭で false に戻す。
 *      タイマーに依存せず HMR cleanup と通常 unmount を機械的に区別できる。
 *   2. `import.meta.hot.data.ptyBySessionKey` — HMR cleanup で kill を skip した
 *      PTY id を sessionKey ごとに保存する。production では `import.meta.hot`
 *      自体が undefined なので getHmrPtyCache() は null を返し、本モジュールの
 *      副作用はすべて no-op になる。
 */

export interface HmrPtyCacheEntry {
  ptyId: string;
  generation: number;
}

/** HMR dispose 中フラグ。useEffect cleanup から見える module-scoped 状態。 */
export const hmrDisposeArmed = { current: false };

// dev のみ: HMR dispose hook を 1 回だけ登録する。
// 「タイマーで戻す」のではなく、次の hook mount の effect 冒頭で戻すので、
// React Refresh の cleanup が遅れて走っても判定が壊れない。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __hot = (import.meta as any).hot as
  | {
      dispose: (cb: () => void) => void;
      data?: Record<string, unknown>;
    }
  | undefined;
if (__hot && !(__hot as { __vibePtyHookInstalled?: boolean }).__vibePtyHookInstalled) {
  (__hot as { __vibePtyHookInstalled?: boolean }).__vibePtyHookInstalled = true;
  __hot.dispose(() => {
    // この cb が呼ばれた = HMR が module を捨てる。直後に effect cleanup が
    // 全 hook で走るので、cleanup 側はこのフラグを見て kill skip を判定する。
    hmrDisposeArmed.current = true;
  });
}

/** `import.meta.hot.data.ptyBySessionKey` を sessionKey → ptyId の Map として参照する。 */
export function getHmrPtyCache(): Record<string, HmrPtyCacheEntry> | null {
  // dev mode 限定。本番ビルドでは import.meta.hot が undefined なので null を返す。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hot = (import.meta as any).hot as
    | { data?: Record<string, unknown> }
    | undefined;
  if (!hot) return null;
  if (!hot.data) return null;
  if (!hot.data.ptyBySessionKey) {
    hot.data.ptyBySessionKey = {} as Record<string, HmrPtyCacheEntry>;
  }
  return hot.data.ptyBySessionKey as Record<string, HmrPtyCacheEntry>;
}

/**
 * 直前の世代番号 + 1 を払い出し、cache に「自分が現世代である」と記録する。
 * cache が無い (本番ビルド) / sessionKey が無い場合は 1 を返す。
 *
 * use-xterm-bind の effect 先頭で 1 度だけ呼ばれ、以降の listener コールバックは
 * 自分の myGeneration を覚えておき、isCurrentGeneration() で世代外を弾く。
 */
export function acquireGeneration(sessionKey: string | undefined): number {
  const cache = getHmrPtyCache();
  if (!cache || !sessionKey) return 1;
  const entry = cache[sessionKey];
  const next = (entry?.generation ?? 0) + 1;
  cache[sessionKey] = { ptyId: entry?.ptyId ?? '', generation: next };
  return next;
}

/**
 * listener が登録された世代と現在の世代が一致するかを判定。一致しない場合、
 * 古い世代の listener は no-op に倒すべき (HMR remount で 2 重 bind した
 * 旧 callback が xterm に二重出力するのを防ぐ)。
 *
 * cache が無い / sessionKey 無しの場合は常に true (世代管理対象外)。
 */
export function isCurrentGeneration(
  sessionKey: string | undefined,
  myGeneration: number
): boolean {
  if (!sessionKey) return true;
  const cache = getHmrPtyCache();
  if (!cache) return true;
  return cache[sessionKey]?.generation === myGeneration;
}

/** HMR cache に「sessionKey に対する最新の ptyId と世代」を upsert する。 */
export function cacheUpsert(
  sessionKey: string | undefined,
  ptyId: string,
  generation: number
): void {
  if (!sessionKey) return;
  const cache = getHmrPtyCache();
  if (!cache) return;
  cache[sessionKey] = { ptyId, generation };
}

/** HMR cache から sessionKey の entry を削除 (PTY が exit したり通常 cleanup したとき)。 */
export function cacheDelete(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  const cache = getHmrPtyCache();
  if (!cache) return;
  delete cache[sessionKey];
}

/** sessionKey の entry を読み取る (mount 時に「再接続できる ptyId はあるか」判定用)。 */
export function cacheGet(sessionKey: string | undefined): HmrPtyCacheEntry | undefined {
  if (!sessionKey) return undefined;
  const cache = getHmrPtyCache();
  if (!cache) return undefined;
  return cache[sessionKey];
}
