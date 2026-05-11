/**
 * AppMenuBar — Topbar 左側の「ファイル / 表示 / ヘルプ」共通メニューバー。
 *
 * App.tsx (IDE) と CanvasLayout.tsx (Canvas) で同一の項目を出すために抽出した。
 * 各レイアウトはハンドラだけ供給する。表示順・アイコン・shortcut はここで集約。
 */
import {
  Clock,
  Command as CommandIcon,
  ExternalLink,
  File as FileIcon,
  Folder as FolderIcon,
  FolderPlus,
  LayoutGrid,
  PanelLeft,
  RefreshCw,
  RotateCw,
  Settings as SettingsIcon
} from 'lucide-react';
import { MenuBar, MenuItem, MenuDivider, MenuSection } from './MenuBar';
import { useT } from '../../lib/i18n';

export interface AppMenuBarProps {
  recentProjects: string[];
  onNewProject: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onAddWorkspaceFolder: () => void;
  onOpenRecent: (path: string) => void;
  onRestart: () => void;
  onCheckUpdate: () => void;
  onOpenGithub: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  onToggleSidebar: () => void;
  onToggleCanvas: () => void;
}

export function AppMenuBar(props: AppMenuBarProps): JSX.Element {
  const t = useT();
  const recents = (props.recentProjects ?? []).slice(0, 6);

  return (
    <MenuBar
      items={[
        {
          label: t('menubar.file'),
          children: (
            <>
              <MenuItem
                icon={<FolderPlus size={14} strokeWidth={1.8} />}
                label={t('appMenu.new')}
                onClick={props.onNewProject}
              />
              <MenuItem
                icon={<FolderIcon size={14} strokeWidth={1.8} />}
                label={t('appMenu.openFolder')}
                onClick={props.onOpenFolder}
              />
              <MenuItem
                icon={<FileIcon size={14} strokeWidth={1.8} />}
                label={t('appMenu.openFile')}
                onClick={props.onOpenFile}
              />
              <MenuItem
                icon={<FolderPlus size={14} strokeWidth={1.8} />}
                label={t('appMenu.addToWorkspace')}
                onClick={props.onAddWorkspaceFolder}
              />
              {recents.length > 0 && (
                <>
                  <MenuDivider />
                  <MenuSection label={t('appMenu.recent')} />
                  {recents.map((p) => (
                    <MenuItem
                      key={p}
                      icon={<Clock size={13} strokeWidth={1.8} />}
                      label={p.split(/[\\/]/).filter(Boolean).pop() ?? p}
                      onClick={() => props.onOpenRecent(p)}
                    />
                  ))}
                </>
              )}
              <MenuDivider />
              <MenuItem
                icon={<RotateCw size={14} strokeWidth={1.8} />}
                label={t('menubar.restart')}
                onClick={props.onRestart}
              />
            </>
          )
        },
        {
          label: t('menubar.view'),
          children: (
            <>
              <MenuItem
                icon={<PanelLeft size={14} strokeWidth={1.8} />}
                label={t('menubar.toggleSidebar')}
                shortcut="Ctrl+B"
                onClick={props.onToggleSidebar}
              />
              <MenuItem
                icon={<LayoutGrid size={14} strokeWidth={1.8} />}
                label={t('menubar.toggleCanvas')}
                shortcut="Ctrl+Shift+M"
                onClick={props.onToggleCanvas}
              />
              <MenuDivider />
              <MenuItem
                icon={<CommandIcon size={14} strokeWidth={1.8} />}
                label={t('menubar.openPalette')}
                shortcut="Ctrl+Shift+P"
                onClick={props.onOpenPalette}
              />
            </>
          )
        },
        {
          label: t('menubar.help'),
          children: (
            <>
              <MenuItem
                icon={<RefreshCw size={14} strokeWidth={1.8} />}
                label={t('updater.checkNow')}
                onClick={props.onCheckUpdate}
              />
              <MenuItem
                icon={<ExternalLink size={14} strokeWidth={1.8} />}
                label={t('menubar.openGithub')}
                onClick={props.onOpenGithub}
              />
              <MenuDivider />
              <MenuItem
                icon={<SettingsIcon size={14} strokeWidth={1.8} />}
                label={t('menubar.openSettings')}
                shortcut="Ctrl+,"
                onClick={props.onOpenSettings}
              />
            </>
          )
        }
      ]}
    />
  );
}
