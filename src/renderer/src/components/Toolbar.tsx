import {
  Command as CommandIcon,
  Folder,
  RotateCw,
  Settings as SettingsIcon
} from 'lucide-react';
import { useT } from '../lib/i18n';

interface ToolbarProps {
  projectRoot: string;
  onRestart: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  status: string;
}

export function Toolbar({
  projectRoot,
  onRestart,
  onOpenSettings,
  onOpenPalette,
  status
}: ToolbarProps): JSX.Element {
  const t = useT();
  const segments = projectRoot.split(/[\\/]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? '';
  const parentPath = segments.slice(Math.max(segments.length - 3, 0), -1).join(' / ');
  const statusTone = /error|failed|missing|warn|warning|失敗|警告|見つかりません/i.test(status)
    ? 'var(--warning)'
    : /loading|starting|checking|読み込み|起動中|確認中/i.test(status)
      ? 'var(--accent)'
      : 'var(--text-mute)';

  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onRestart}
          title={t('toolbar.restart.title')}
          aria-label={t('toolbar.restart.title')}
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </button>

        {projectRoot ? (
          <span className="toolbar__path" title={projectRoot}>
            <Folder size={12} strokeWidth={1.9} className="toolbar__path-icon" />
            <span className="toolbar__path-name">{projectName}</span>
            {parentPath ? (
              <span className="toolbar__path-parent">{parentPath}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="toolbar__right">
        {status ? (
          <span className="toolbar__status" title={status}>
            <span
              className="toolbar__status-dot"
              aria-hidden="true"
              style={{ background: statusTone }}
            />
            <span className="toolbar__status-text">{status}</span>
          </span>
        ) : null}

        <div className="toolbar__control-group">
          <button
            type="button"
            className="toolbar__btn toolbar__btn--icon"
            onClick={onOpenPalette}
            title={t('toolbar.palette.title')}
            aria-label={t('toolbar.palette.title')}
          >
            <CommandIcon size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="toolbar__btn toolbar__btn--icon"
            onClick={onOpenSettings}
            title={t('toolbar.settings.title')}
            aria-label={t('toolbar.settings.title')}
          >
            <SettingsIcon size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}
