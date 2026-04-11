import {
  Command as CommandIcon,
  FileCode,
  RotateCw,
  Save,
  Settings as SettingsIcon
} from 'lucide-react';
import { AppMenu } from './AppMenu';

interface ToolbarProps {
  filePath: string | null;
  dirty: boolean;
  saving: boolean;
  savePulse: boolean;
  onSave: () => void;
  onInsertTemplate: () => void;
  onRestart: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  status: string;
  // プロジェクトメニュー
  recentProjects: string[];
  onNewProject: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

export function Toolbar({
  filePath,
  dirty,
  saving,
  savePulse,
  onSave,
  onInsertTemplate,
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
          className={`toolbar__btn toolbar__btn--primary ${savePulse ? 'is-pulse' : ''}`}
          onClick={onSave}
          disabled={!dirty || saving}
          title="保存 (Ctrl+S)"
        >
          <Save size={14} strokeWidth={2} />
          <span>{saving ? '保存中' : '保存'}</span>
        </button>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon"
          onClick={onInsertTemplate}
          title="テンプレート挿入"
          aria-label="テンプレート挿入"
        >
          <FileCode size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="toolbar__btn toolbar__btn--icon toolbar__btn--warning"
          onClick={onRestart}
          title="アプリを再起動"
          aria-label="再起動"
        >
          <RotateCw size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="toolbar__right">
        {filePath && <span className="toolbar__path">{filePath}</span>}
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
