import { Command as CommandIcon, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { AppMenu } from './AppMenu';

interface ToolbarProps {
  projectRoot: string;
  onRestart: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  status: string;
  recentProjects: string[];
  onNewProject: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

export function Toolbar({
  projectRoot,
  onRestart,
  onOpenSettings,
  onOpenPalette,
  status,
  recentProjects,
  onNewProject,
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  onClearRecent
}: ToolbarProps): JSX.Element {
  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <AppMenu
          recentProjects={recentProjects}
          onNewProject={onNewProject}
          onOpenFolder={onOpenFolder}
          onOpenFile={onOpenFile}
          onOpenRecent={onOpenRecent}
          onClearRecent={onClearRecent}
        />
        <div className="toolbar__divider" />
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onRestart}
          title="アプリを再起動"
          aria-label="再起動"
        >
          <RotateCw size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="toolbar__right">
        {projectRoot && <span className="toolbar__path">{projectRoot}</span>}
        {status && <span className="toolbar__status">{status}</span>}
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onOpenPalette}
          title="コマンドパレット (Ctrl+Shift+P)"
          aria-label="コマンドパレット"
        >
          <CommandIcon size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onOpenSettings}
          title="設定 (Ctrl+,)"
          aria-label="設定"
        >
          <SettingsIcon size={16} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
