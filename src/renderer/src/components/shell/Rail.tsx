import { useCallback, useMemo } from 'react';
import { Files, GitBranch, History, LayoutGrid, Settings as SettingsIcon, StickyNote } from 'lucide-react';
import type { SidebarView } from '../Sidebar';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../stores/ui';

interface RailProps {
  sidebarView: SidebarView;
  onSidebarViewChange: (v: SidebarView) => void;
  changeCount: number;
  onOpenSettings: () => void;
  /** プロジェクトが git リポジトリかどうか。false のとき Changes タブを Rail から外す。
   *  undefined / true は表示 (status 取得前に一瞬で消えるのを避けるためデフォルト表示)。 */
  hasGitRepo?: boolean;
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
  onOpenSettings,
  hasGitRepo = true
}: RailProps): JSX.Element {
  const t = useT();
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // tab クリックの挙動 (VS Code 互換):
  //   - アクティブタブ + sidebar 開 → 折り畳み
  //   - アクティブタブ + sidebar 閉 → 開く
  //   - 別タブ → そのタブに切替 (折り畳まれていたら開く)
  const handleTabClick = useCallback(
    (view: SidebarView): void => {
      if (sidebarView === view) {
        toggleSidebar();
        return;
      }
      onSidebarViewChange(view);
      if (sidebarCollapsed) setSidebarCollapsed(false);
    },
    [sidebarView, toggleSidebar, onSidebarViewChange, sidebarCollapsed, setSidebarCollapsed]
  );

  const items = useMemo<
    Array<{
      view: SidebarView;
      label: string;
      icon: JSX.Element;
      count?: number;
    }>
  >(
    () => [
      { view: 'files', label: t('sidebar.files'), icon: <Files size={17} strokeWidth={2.2} /> },
      // git リポジトリでない場合は Changes タブごと表示しない
      ...(hasGitRepo
        ? [
            {
              view: 'changes' as SidebarView,
              label: t('sidebar.changes'),
              icon: <GitBranch size={17} strokeWidth={2.2} />,
              count: changeCount
            }
          ]
        : []),
      {
        view: 'sessions',
        label: t('sidebar.history'),
        icon: <History size={17} strokeWidth={2.2} />
      },
      { view: 'notes', label: t('sidebar.notes'), icon: <StickyNote size={17} strokeWidth={2.2} /> }
    ],
    [t, hasGitRepo, changeCount]
  );

  return (
    <nav className="rail" aria-label="Primary navigation">
      {items.map((item) => {
        // sidebar 折り畳み中は「アクティブ表示」にしない (どれも開いていないので誤解の元)
        const active = !sidebarCollapsed && sidebarView === item.view;
        return (
          <button
            key={item.view}
            type="button"
            className={`rail__btn${active ? ' is-active' : ''}`}
            onClick={() => handleTabClick(item.view)}
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
        <LayoutGrid size={17} strokeWidth={2.2} />
      </button>

      <span className="rail__spacer" />

      <button
        type="button"
        className="rail__btn"
        onClick={onOpenSettings}
        title={t('toolbar.settings.title')}
        aria-label={t('toolbar.settings.title')}
      >
        <SettingsIcon size={17} strokeWidth={2.2} />
      </button>
    </nav>
  );
}
