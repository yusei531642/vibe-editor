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
