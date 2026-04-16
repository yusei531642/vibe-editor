import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  ExternalLink,
  Package,
  Info,
  Languages,
  Moon,
  Palette,
  Settings as SettingsIcon,
  Sun,
  User
} from 'lucide-react';
import type { AppUserInfo, Language, ThemeName } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useSettings } from '../lib/settings-context';
import { useScaleMount } from '../lib/use-animated-mount';

interface UserMenuProps {
  onOpenSettings: () => void;
}

const LANG_LABELS: Record<Language, string> = {
  ja: '日本語',
  en: 'English'
};

const THEME_LABELS: Record<ThemeName, string> = {
  'claude-dark': 'Claude Dark',
  'claude-light': 'Claude Light',
  dark: 'Dark',
  midnight: 'Midnight',
  light: 'Light'
};

const LIGHT_THEMES: Set<ThemeName> = new Set(['claude-light', 'light']);

/**
 * サイドバー最下段に表示されるユーザー行 + クリックで開くドロップダウンメニュー。
 * Claude.ai の左下プロファイルメニューを参考にした軽量版。
 *
 * メニュー項目:
 *  - 設定 (Ctrl+,)
 *  - 言語(サブメニュー: 日本語 / English)
 *  - テーマトグル(明/暗をワンタップで切替)
 *  - GitHub でリリースを見る
 *  - バージョン情報(最下段にフッター的に表示)
 */
export function UserMenu({ onOpenSettings }: UserMenuProps): JSX.Element {
  const t = useT();
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [info, setInfo] = useState<AppUserInfo | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 初回 or 開いた瞬間にユーザー情報を取得する
  useEffect(() => {
    let cancelled = false;
    void window.api.app.getUserInfo().then((res) => {
      if (!cancelled) setInfo(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // クリック外し / ESC でメニューを閉じる
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setLangOpen(false);
        setThemeOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        setLangOpen(false);
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const isLight = LIGHT_THEMES.has(settings.theme);
  const { mounted, dataState, motion } = useScaleMount(open, 160);

  const toggleLight = (): void => {
    // 明 ↔ 暗 をワンタップで切り替える。Claude テーマは対になっているので
    // claude-dark ⇄ claude-light を優先、それ以外は dark ⇄ light にマップ。
    const next: ThemeName = isLight
      ? settings.theme === 'claude-light'
        ? 'claude-dark'
        : 'dark'
      : settings.theme === 'claude-dark'
        ? 'claude-light'
        : 'light';
    void update({ theme: next });
  };

  const pickLang = (lang: Language): void => {
    void update({ language: lang });
    setLangOpen(false);
    setOpen(false);
  };

  const pickTheme = (theme: ThemeName): void => {
    void update({ theme });
    setThemeOpen(false);
    setOpen(false);
  };

  const openReleases = (): void => {
    void window.api.app.openExternal(
      'https://github.com/yusei531642/vibe-editor/releases'
    );
    setOpen(false);
  };

  return (
    <div className="user-menu" ref={rootRef}>
      <div className="user-menu__trigger-wrap">
        <button
          type="button"
          className={`user-menu__trigger${open ? ' is-open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={info?.username ?? ''}
        >
          <span className="user-menu__avatar" aria-hidden="true">
            <User size={12} strokeWidth={2.25} />
          </span>
          <span className="user-menu__identity">
            <span className="user-menu__name">{info?.username ?? '…'}</span>
            <span className="user-menu__meta">
              {LANG_LABELS[settings.language]} · {THEME_LABELS[settings.theme]}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="user-menu__theme-toggle"
          onClick={toggleLight}
          aria-label={isLight ? 'Dark mode' : 'Light mode'}
          title={isLight ? 'Dark mode' : 'Light mode'}
        >
          {isLight ? <Sun size={14} strokeWidth={1.75} /> : <Moon size={14} strokeWidth={1.75} />}
        </button>
      </div>

      {mounted && (
        <div
          className="user-menu__dropdown"
          data-state={dataState}
          data-motion={motion}
          role="menu"
        >
          <div className="user-menu__header">
            <div className="user-menu__avatar user-menu__avatar--lg" aria-hidden="true">
              <User size={16} strokeWidth={2.25} />
            </div>
            <div className="user-menu__header-text">
              <div className="user-menu__header-name">{info?.username ?? ''}</div>
              <div className="user-menu__header-sub">
                vibe-editor v{info?.version ?? ''}
              </div>
            </div>
          </div>

          <div className="user-menu__divider" />

          <button
            type="button"
            className="user-menu__item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <SettingsIcon size={14} strokeWidth={1.75} className="user-menu__item-icon" />
            <span className="user-menu__item-label">{t('userMenu.settings')}</span>
            <span className="user-menu__item-shortcut">Ctrl+,</span>
          </button>

          {/* 言語: サブメニューを展開 */}
          <button
            type="button"
            className={`user-menu__item user-menu__item--sub${langOpen ? ' is-open' : ''}`}
            role="menuitem"
            onClick={() => {
              setLangOpen((v) => !v);
              setThemeOpen(false);
            }}
          >
            <Languages size={14} strokeWidth={1.75} className="user-menu__item-icon" />
            <span className="user-menu__item-label">{t('userMenu.language')}</span>
            <span className="user-menu__item-value">{LANG_LABELS[settings.language]}</span>
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={`user-menu__sub-caret${langOpen ? ' is-open' : ''}`}
            />
          </button>
          {langOpen && (
            <div className="user-menu__sub">
              {(['ja', 'en'] as Language[]).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  className={`user-menu__sub-item${
                    settings.language === lang ? ' is-active' : ''
                  }`}
                  onClick={() => pickLang(lang)}
                >
                  {LANG_LABELS[lang]}
                </button>
              ))}
            </div>
          )}

          {/* テーマ: サブメニュー */}
          <button
            type="button"
            className={`user-menu__item user-menu__item--sub${themeOpen ? ' is-open' : ''}`}
            role="menuitem"
            onClick={() => {
              setThemeOpen((v) => !v);
              setLangOpen(false);
            }}
          >
            <Palette size={14} strokeWidth={1.75} className="user-menu__item-icon" />
            <span className="user-menu__item-label">{t('userMenu.theme')}</span>
            <span className="user-menu__item-value">{THEME_LABELS[settings.theme]}</span>
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={`user-menu__sub-caret${themeOpen ? ' is-open' : ''}`}
            />
          </button>
          {themeOpen && (
            <div className="user-menu__sub">
              {(Object.keys(THEME_LABELS) as ThemeName[]).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={`user-menu__sub-item${
                    settings.theme === theme ? ' is-active' : ''
                  }`}
                  onClick={() => pickTheme(theme)}
                >
                  {THEME_LABELS[theme]}
                </button>
              ))}
            </div>
          )}

          <div className="user-menu__divider" />

          <button
            type="button"
            className="user-menu__item"
            role="menuitem"
            onClick={openReleases}
          >
            <Package size={14} strokeWidth={1.75} className="user-menu__item-icon" />
            <span className="user-menu__item-label">{t('userMenu.releases')}</span>
            <ExternalLink size={11} strokeWidth={2} className="user-menu__item-ext" />
          </button>

          <div className="user-menu__footer">
            <Info size={11} strokeWidth={1.75} />
            <span>
              v{info?.version ?? ''} · Electron {info?.electronVersion ?? ''} ·{' '}
              {info?.platform ?? ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
