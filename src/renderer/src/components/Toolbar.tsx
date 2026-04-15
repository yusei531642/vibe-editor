import { Command as CommandIcon, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { useT } from '../lib/i18n';

interface ToolbarProps {
  projectRoot: string;
  onRestart: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  status: string;
}

/**
 * メインヘッダー。Issue #6 により AppMenu(ハンバーガー) は Sidebar 側に移動したため、
 * ここには Restart・パレット・設定などの軽量アクションと、現在のプロジェクトパス
 * だけを残している。Issue #5 の指示どおり高さは極力切り詰める。
 */
export function Toolbar({
  projectRoot,
  onRestart,
  onOpenSettings,
  onOpenPalette,
  status
}: ToolbarProps): JSX.Element {
  const t = useT();
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
  );
}
