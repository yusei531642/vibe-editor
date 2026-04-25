import { Files, GitBranch, History, LayoutGrid, Settings as SettingsIcon, StickyNote } from 'lucide-react';
import type { SidebarView } from '../Sidebar';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../stores/ui';

interface RailProps {
  sidebarView: SidebarView;
  onSidebarViewChange: (v: SidebarView) => void;
  changeCount: number;
  historyCount: number;
  onOpenSettings: () => void;
}

/**
 * Redesign shell の 56px 縦アイコンレール。
 * Files / Changes / History / Notes のタブを従来 Sidebar の上部から移設し、
 * モード切替 (Canvas) と設定をレール最下段に固定する。
 * active 状態では左端に 3px の accent バー + 軽い背景を描画。
 */
export function Rail({
  sidebarView,
  onSidebarViewChange,
  changeCount,
  historyCount,
  onOpenSettings
}: RailProps): JSX.Element {
  const t = useT();
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);

  const items: Array<{
    view: SidebarView;
    label: string;
    icon: JSX.Element;
    count?: number;
  }> = [
    { view: 'files', label: t('sidebar.files'), icon: <Files size={16} strokeWidth={1.9} /> },
    {
      view: 'changes',
      label: t('sidebar.changes'),
      icon: <GitBranch size={16} strokeWidth={1.9} />,
      count: changeCount
    },
    {
      view: 'sessions',
      label: t('sidebar.history'),
      icon: <History size={16} strokeWidth={1.9} />,
      count: historyCount
    },
    { view: 'notes', label: t('sidebar.notes'), icon: <StickyNote size={16} strokeWidth={1.9} /> }
  ];

  return (
    <nav className="rail" aria-label="Primary navigation">
      {items.map((item) => {
        const active = sidebarView === item.view;
        return (
          <button
            key={item.view}
            type="button"
            className={`rail__btn${active ? ' is-active' : ''}`}
            onClick={() => onSidebarViewChange(item.view)}
            title={item.label}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
          >
            {item.icon}
            {item.count && item.count > 0 ? (
              <span className="rail__badge">{item.count > 99 ? '99+' : item.count}</span>
            ) : null}
          </button>
        );
      })}

      <span className="rail__divider" />

      <button
        type="button"
        className={`rail__btn${viewMode === 'canvas' ? ' is-active' : ''}`}
        onClick={() => setViewMode(viewMode === 'canvas' ? 'ide' : 'canvas')}
        title={t('topbar.mode.canvas')}
        aria-label={t('topbar.mode.canvas')}
        aria-current={viewMode === 'canvas' ? 'page' : undefined}
      >
        <LayoutGrid size={16} strokeWidth={1.9} />
      </button>

      <span className="rail__spacer" />

      <button
        type="button"
        className="rail__btn"
        onClick={onOpenSettings}
        title={t('toolbar.settings.title')}
        aria-label={t('toolbar.settings.title')}
      >
        <SettingsIcon size={16} strokeWidth={1.9} />
      </button>
    </nav>
  );
}
