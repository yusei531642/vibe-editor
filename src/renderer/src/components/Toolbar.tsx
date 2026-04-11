import { Command as CommandIcon, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { AppMenu } from './AppMenu';
import { useT } from '../lib/i18n';

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
  const t = useT();
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
          title={t('toolbar.restart.title')}
          aria-label={t('toolbar.restart.title')}
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
          title={t('toolbar.palette.title')}
          aria-label={t('toolbar.palette.title')}
        >
          <CommandIcon size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onOpenSettings}
          title={t('toolbar.settings.title')}
          aria-label={t('toolbar.settings.title')}
        >
          <SettingsIcon size={16} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
