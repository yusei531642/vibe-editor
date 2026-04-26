import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
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

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState<boolean>(true);
  // Issue #25: update() が古い settings クロージャを元に次状態を作ると、短時間に複数の
  // 独立な patch が走った場合に後発 save が先発の patch を巻き戻しうる。
  // state をそのまま deps にすると再レンダー ごとに update が再生成され、すでに渡された
  // callback が stale になるのも別の落とし穴。
  // → ref に最新 settings をミラーし、update() は常に ref.current を起点に merge する。
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;

  // 初回読み込み
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await window.api.settings.load();
        if (cancelled) return;
        // Issue #75: schemaVersion に従った明示マイグレーションを挟む。
        // 単純な shallow merge だけでは型変更や意味変更を吸収できない。
        const merged = migrateSettings(loaded);
        // Issue #71: 初回起動で settings.json がまだ無い場合、OS ロケールから language を決める。
        // `loaded` が空 (settings.json 未作成) かつ loaded.language が未定義のときのみ適用。
        const hasSavedLanguage =
          loaded != null &&
          typeof loaded === 'object' &&
          'language' in (loaded as Record<string, unknown>);
        if (!hasSavedLanguage) {
          const loc = (navigator.language || 'en').toLowerCase();
          merged.language = loc.startsWith('ja') ? 'ja' : 'en';
        }
        settingsRef.current = merged;
        setSettings(merged);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // テーマ・フォントを DOM に反映
  useEffect(() => {
    applyTheme(settings.theme, settings.uiFontFamily, settings.uiFontSize);
  }, [settings.theme, settings.uiFontFamily, settings.uiFontSize]);

  // Issue #161: webview zoom を settings から復元 + apply のたびに settings に書き戻す。
  // restore は loading 完了直後の 1 回だけ。callback は永続化される設定が in-memory に
  // 反映され続けるよう常時登録。
  useEffect(() => {
    if (loading) return;
    void import('./webview-zoom').then(({ webviewZoom }) => {
      webviewZoom.restoreFromSettings(settings.webviewZoom);
      webviewZoom.setPersistCallback((next) => {
        // settingsRef に直接書き戻す + 永続化トリガ (debounce 経路に乗る)
        const updated = { ...settingsRef.current, webviewZoom: next };
        settingsRef.current = updated;
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
    // 復元は初回 loading 解除時のみ。以降は callback 経由で保存だけする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 情報密度を DOM に反映
  useEffect(() => {
    applyDensity(settings.density);
  }, [settings.density]);

  // Issue #29: 現在の project root (lastOpenedRoot / fallback claudeCwd) を Rust 側 state
  // へ同期する。watcher や app_get_project_root の SSOT として使われる。
  const lastSyncedRootRef = useRef<string>('');
  useEffect(() => {
    const effectiveRoot = (settings.lastOpenedRoot || settings.claudeCwd || '').trim();
    if (effectiveRoot === lastSyncedRootRef.current) return;
    lastSyncedRootRef.current = effectiveRoot;
    void window.api.app.setProjectRoot(effectiveRoot).catch((err) => {
      console.warn('[settings] setProjectRoot failed:', err);
    });
  }, [settings.lastOpenedRoot, settings.claudeCwd]);

  // Issue #131: save を 200ms debounce してバッチ化する。
  // patch 1 つごとに settings.json 全文 atomic_write していたため、
  // claudeCodePanelWidth リサイズ確定や workspace 追加で UI が IPC await で
  // ブロックしていた。ref を持っているので最新値が即座に in-memory で見える。
  const saveTimerRef = useRef<number | null>(null);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    // 常に最新値 (ref) を起点に merge。ref を先行コミットすることで、
    // await 中に走る次の update() 呼び出しが今の patch を含んだ state を見る。
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void window.api.settings.save(settingsRef.current).catch((err) => {
        console.error('[settings] 保存失敗:', err);
      });
    }, 200);
  }, []);

  // ページ離脱直前に未 flush の save を確定させる。debounce 中の値が永続化漏れにならないように。
  useEffect(() => {
    const handler = (): void => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        // window 終了直前なので fire-and-forget で sync 風に投げる
        void window.api.settings.save(settingsRef.current).catch(() => {
          /* shutdown 時のエラーは無視 */
        });
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const reset = useCallback(async () => {
    settingsRef.current = DEFAULT_SETTINGS;
    setSettings(DEFAULT_SETTINGS);
    await window.api.settings.save(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, loading, update, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings は SettingsProvider の子孫で呼び出してください');
  return ctx;
}

/** アクティブな Monaco テーマ名を返す簡易フック */
export function useMonacoTheme(): 'vs-dark' | 'vs' | 'hc-black' | 'claude-dark' | 'claude-light' {
  const { settings } = useSettings();
  return THEMES[settings.theme].monacoTheme;
}
