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
        // 既存 settings.json に新フィールドが無い場合 (notepad など) は
        // DEFAULT_SETTINGS で穴埋めする。forward compat。
        const merged: AppSettings = { ...DEFAULT_SETTINGS, ...loaded };
        // Issue #71: language が保存されていない初回起動時のみ、OS ロケールから既定を決める。
        if (!loaded || typeof loaded !== 'object' || !(loaded as Partial<AppSettings>).language) {
          const loc = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
          merged.language = loc.toLowerCase().startsWith('ja') ? 'ja' : 'en';
        }
        // Issue #75: 既存の不正値 (language / theme / density の enum 外) を runtime 検証する。
        const ALLOWED_LANG = ['ja', 'en'] as const;
        if (!ALLOWED_LANG.includes(merged.language as (typeof ALLOWED_LANG)[number])) {
          merged.language = DEFAULT_SETTINGS.language;
        }
        if (!THEMES[merged.theme as keyof typeof THEMES]) {
          merged.theme = DEFAULT_SETTINGS.theme;
        }
        const ALLOWED_DENSITY = ['compact', 'normal', 'comfortable'] as const;
        if (!ALLOWED_DENSITY.includes(merged.density as (typeof ALLOWED_DENSITY)[number])) {
          merged.density = DEFAULT_SETTINGS.density;
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

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    // 常に最新値 (ref) を起点に merge。ref を先行コミットすることで、
    // await 中に走る次の update() 呼び出しが今の patch を含んだ state を見る。
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    try {
      await window.api.settings.save(next);
    } catch (err) {
      console.error('[settings] 保存失敗:', err);
    }
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
export function useMonacoTheme(): 'vs-dark' | 'vs' | 'hc-black' {
  const { settings } = useSettings();
  return THEMES[settings.theme].monacoTheme;
}
