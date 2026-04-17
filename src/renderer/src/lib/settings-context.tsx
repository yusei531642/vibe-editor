import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

  // 初回読み込み
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await window.api.settings.load();
        if (cancelled) return;
        // 既存 settings.json に新フィールドが無い場合 (notepad など) は
        // DEFAULT_SETTINGS で穴埋めする。forward compat。
        setSettings({ ...DEFAULT_SETTINGS, ...loaded });
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

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      try {
        await window.api.settings.save(next);
      } catch (err) {
        console.error('[settings] 保存失敗:', err);
      }
    },
    [settings]
  );

  const reset = useCallback(async () => {
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
