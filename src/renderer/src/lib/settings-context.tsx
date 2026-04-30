import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactNode
} from 'react';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../types/shared';
import { migrateSettings } from './settings-migrate';
import { applyDensity, applyTheme, THEMES } from './themes';

interface SettingsContextValue {
  settings: AppSettings;
  loading: boolean;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

interface SettingsSnapshot {
  settings: AppSettings;
  loading: boolean;
}

interface SettingsStore {
  getSnapshot: () => SettingsSnapshot;
  subscribe: (listener: () => void) => () => void;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

// Issue #338: HMR で settings-context.tsx が再評価されると SettingsContext インスタンスが
// 作り直され、別 HMR boundary の consumer (i18n.ts → use-terminal-clipboard.ts 等) が旧
// Context 参照を保持して `useContext` が null を返す → throw → fewer hooks chain。
// これを防ぐため、Context インスタンスは globalThis に保存して identity を維持する。
type SettingsContextSlot = Context<SettingsStore | null>;
declare global {
  // eslint-disable-next-line no-var
  var __vibeSettingsContext: SettingsContextSlot | undefined;
}
const SettingsContext: SettingsContextSlot =
  globalThis.__vibeSettingsContext ?? createContext<SettingsStore | null>(null);
if (!globalThis.__vibeSettingsContext) {
  globalThis.__vibeSettingsContext = SettingsContext;
}

// Issue #338: 自モジュールの HMR を受け入れて再評価伝播を止める。dev のみ有効。
// production では import.meta.hot は undefined なので no-op。
const __hot = (import.meta as unknown as { hot?: { accept: (cb?: () => void) => void } }).hot;
if (__hot) {
  __hot.accept(() => {
    // 何もしない: Context 識別子は globalThis 経由で保たれているので、
    // モジュール再評価しても provider/consumer は同じ Context を見る。
  });
}

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settingsState, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loadingState, setLoadingState] = useState<boolean>(true);

  const settingsRef = useRef<AppSettings>(settingsState);
  const loadingRef = useRef<boolean>(loadingState);
  const snapshotRef = useRef<SettingsSnapshot>({
    settings: settingsState,
    loading: loadingState
  });
  const listenersRef = useRef(new Set<() => void>());
  const saveTimerRef = useRef<number | null>(null);

  const emitSnapshot = useCallback((): void => {
    snapshotRef.current = {
      settings: settingsRef.current,
      loading: loadingRef.current
    };
    for (const listener of listenersRef.current) listener();
  }, []);

  const commitState = useCallback(
    (nextSettings: AppSettings, nextLoading: boolean): void => {
      settingsRef.current = nextSettings;
      loadingRef.current = nextLoading;
      snapshotRef.current = { settings: nextSettings, loading: nextLoading };
      setSettingsState(nextSettings);
      setLoadingState(nextLoading);
      for (const listener of listenersRef.current) listener();
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await window.api.settings.load();
        if (cancelled) return;
        const merged = migrateSettings(loaded);
        const hasSavedLanguage =
          loaded != null &&
          typeof loaded === 'object' &&
          'language' in (loaded as Record<string, unknown>);
        if (!hasSavedLanguage) {
          const loc = (navigator.language || 'en').toLowerCase();
          merged.language = loc.startsWith('ja') ? 'ja' : 'en';
        }
        commitState(merged, false);
      } finally {
        if (!cancelled && loadingRef.current) {
          commitState(settingsRef.current, false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitState]);

  useEffect(() => {
    // Issue #260 自己レビュー R-W1: settings load 完了前 (loadingState=true) は
    // `DEFAULT_SETTINGS.theme = 'claude-dark'` で applyTheme が走ってしまい、Rust 側
    // setup の `theme=='glass'` 初期適用と競合する。load 完了後の effect で「実際の
    // ユーザー設定」が反映されるので、loading 中は CSS 変数の更新も IPC 発火も skip する。
    if (loadingState) return;
    applyTheme(
      settingsState.theme,
      settingsState.uiFontFamily,
      settingsState.uiFontSize
    );
  }, [
    loadingState,
    settingsState.theme,
    settingsState.uiFontFamily,
    settingsState.uiFontSize
  ]);

  useEffect(() => {
    if (loadingState) return;
    void import('./webview-zoom').then(({ webviewZoom }) => {
      webviewZoom.restoreFromSettings(settingsState.webviewZoom);
      webviewZoom.setPersistCallback((next) => {
        const updated = { ...settingsRef.current, webviewZoom: next };
        settingsRef.current = updated;
        emitSnapshot();
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          void window.api.settings.save(settingsRef.current).catch(() => {});
        }, 200);
      });
    });
    return () => {
      void import('./webview-zoom').then(({ webviewZoom }) => {
        webviewZoom.setPersistCallback(null);
      });
    };
  }, [emitSnapshot, loadingState, settingsState.webviewZoom]);

  useEffect(() => {
    applyDensity(settingsState.density);
  }, [settingsState.density]);

  const lastSyncedRootRef = useRef<string>('');
  useEffect(() => {
    const effectiveRoot = (settingsState.lastOpenedRoot || settingsState.claudeCwd || '').trim();
    if (effectiveRoot === lastSyncedRootRef.current) return;
    lastSyncedRootRef.current = effectiveRoot;
    void window.api.app.setProjectRoot(effectiveRoot).catch((err) => {
      console.warn('[settings] setProjectRoot failed:', err);
    });
  }, [settingsState.lastOpenedRoot, settingsState.claudeCwd]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      commitState(next, loadingRef.current);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void window.api.settings.save(settingsRef.current).catch((err) => {
          console.error('[settings] 保存失敗:', err);
        });
      }, 200);
    },
    [commitState]
  );

  useEffect(() => {
    const handler = (): void => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void window.api.settings.save(settingsRef.current).catch(() => {
          /* shutdown 時のエラーは無視 */
        });
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const reset = useCallback(async () => {
    commitState(DEFAULT_SETTINGS, loadingRef.current);
    await window.api.settings.save(DEFAULT_SETTINGS);
  }, [commitState]);

  const store = useMemo<SettingsStore>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
      update,
      reset
    }),
    [reset, update]
  );

  return <SettingsContext.Provider value={store}>{children}</SettingsContext.Provider>;
}

function useSettingsStore(): SettingsStore {
  const store = useContext(SettingsContext);
  if (!store) throw new Error('useSettings は SettingsProvider の子孫で呼び出してください');
  return store;
}

export function useSettingsSelector<T>(
  selector: (snapshot: SettingsSnapshot) => T
): T {
  const store = useSettingsStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot())
  );
}

export function useSettingsValue<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return useSettingsSelector((snapshot) => snapshot.settings[key]);
}

export function useSettingsLoading(): boolean {
  return useSettingsSelector((snapshot) => snapshot.loading);
}

export function useSettingsActions(): Pick<SettingsContextValue, 'update' | 'reset'> {
  const store = useSettingsStore();
  return useMemo(
    () => ({
      update: store.update,
      reset: store.reset
    }),
    [store]
  );
}

export function useSettings(): SettingsContextValue {
  const store = useSettingsStore();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  return useMemo(
    () => ({
      settings: snapshot.settings,
      loading: snapshot.loading,
      update: store.update,
      reset: store.reset
    }),
    [snapshot.loading, snapshot.settings, store]
  );
}

export function useMonacoTheme(): 'vs-dark' | 'vs' | 'hc-black' | 'claude-dark' | 'claude-light' {
  const theme = useSettingsValue('theme');
  return THEMES[theme].monacoTheme;
}
