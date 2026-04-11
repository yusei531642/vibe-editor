import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Clock,
  File,
  Folder,
  FolderPlus,
  Menu
} from 'lucide-react';
import { useT } from '../lib/i18n';

export interface AppMenuProps {
  recentProjects: string[];
  onNewProject: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

/**
 * 左上の「☰ プロジェクト」ドロップダウンメニュー。
 */
export function AppMenu({
  recentProjects,
  onNewProject,
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  onClearRecent
}: AppMenuProps): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const shortName = (abs: string): string => {
    const parts = abs.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || abs;
  };

  const pickAndClose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="app-menu" ref={rootRef}>
      <button
        type="button"
        className={`app-menu__trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('appMenu.title')}
      >
        <Menu size={16} strokeWidth={2} />
        <ChevronDown size={12} strokeWidth={2} className="app-menu__caret" />
      </button>

      {open && (
        <div className="app-menu__dropdown" role="menu">
          <button
            type="button"
            className="app-menu__item"
            role="menuitem"
            onClick={pickAndClose(onNewProject)}
          >
            <FolderPlus size={16} strokeWidth={1.75} className="app-menu__item-icon" />
            <span className="app-menu__item-label">{t('appMenu.new')}</span>
            <span className="app-menu__item-hint">{t('appMenu.newHint')}</span>
          </button>
          <button
            type="button"
            className="app-menu__item"
            role="menuitem"
            onClick={pickAndClose(onOpenFolder)}
          >
            <Folder size={16} strokeWidth={1.75} className="app-menu__item-icon" />
            <span className="app-menu__item-label">{t('appMenu.openFolder')}</span>
            <span className="app-menu__item-hint">{t('appMenu.openFolderHint')}</span>
          </button>
          <button
            type="button"
            className="app-menu__item"
            role="menuitem"
            onClick={pickAndClose(onOpenFile)}
          >
            <File size={16} strokeWidth={1.75} className="app-menu__item-icon" />
            <span className="app-menu__item-label">{t('appMenu.openFile')}</span>
            <span className="app-menu__item-hint">{t('appMenu.openFileHint')}</span>
          </button>

          <div className="app-menu__divider" />

          <div className="app-menu__section-label">
            <span>{t('appMenu.recent')}</span>
            {recentProjects.length > 0 && (
              <button
                type="button"
                className="app-menu__clear"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearRecent();
                }}
              >
                {t('appMenu.clear')}
              </button>
            )}
          </div>

          {recentProjects.length === 0 ? (
            <div className="app-menu__empty">{t('appMenu.empty')}</div>
          ) : (
            recentProjects.slice(0, 8).map((p) => (
              <button
                key={p}
                type="button"
                className="app-menu__item app-menu__item--recent"
                role="menuitem"
                onClick={pickAndClose(() => onOpenRecent(p))}
                title={p}
              >
                <Clock size={14} strokeWidth={1.75} className="app-menu__item-icon" />
                <span className="app-menu__item-label">{shortName(p)}</span>
                <span className="app-menu__item-hint">{p}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
