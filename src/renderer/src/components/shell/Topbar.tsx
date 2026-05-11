import { type ReactNode } from 'react';
import { ArrowDownToLine, Search } from 'lucide-react';
import { useT } from '../../lib/i18n';
import type { AvailableUpdateInfo } from '../../lib/updater-check';
import { WindowControls } from './WindowControls';

interface TopbarProps {
  projectRoot: string;
  status: string;
  onOpenPalette: () => void;
  /** 左側に置く自作メニューバー (File / View / Help…) */
  menuBar?: ReactNode;
  /** silentCheckForUpdate で検出された更新情報。null のときボタンは出さない */
  availableUpdate?: AvailableUpdateInfo | null;
  /** 「更新」ボタンが押されたとき。runUpdateInstall を呼び出す想定 */
  onClickUpdate?: () => void;
  /**
   * status の右側、icons の左側に追加で表示するアクション群。
   * Canvas モードの IDE 切替 / Clear ボタンをここに差し込むことで、
   * canvas モード専用の 2 段目ヘッダー (旧 .canvas-header) を撤廃する。
   */
  extraActions?: ReactNode;
}

/**
 * Redesign shell の上端バー (44px)。
 * Claude Design バンドル "vibe-editor Redesign" の .topbar セクションを
 * Tauri アプリ向けに移植。ブランドドット + プロジェクトクラム + モードピル
 * + ⌘K 検索トリガで構成。
 */
export function Topbar({
  projectRoot,
  status,
  onOpenPalette,
  menuBar,
  availableUpdate,
  onClickUpdate,
  extraActions
}: TopbarProps): JSX.Element {
  const t = useT();
  const segments = projectRoot.split(/[\\/]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? '';
  const parentSlice = segments.slice(Math.max(segments.length - 2, 0), -1).join(' / ');
  const isError = /error|failed|missing|warn|warning|失敗|警告|見つかりません/i.test(status);
  const isLoading = /loading|starting|checking|読み込み|起動中|確認中/i.test(status);
  const dotColor = isError
    ? 'var(--warning)'
    : isLoading
      ? 'var(--accent)'
      : 'var(--success)';

  return (
    <div className="topbar" role="banner" data-tauri-drag-region>
      <div className="topbar__brand" data-tauri-drag-region title="vibe-editor">
        <img
          className="topbar__brand-logo"
          src="/vibe-editor.png"
          alt="vibe-editor"
          draggable={false}
        />
        <span>vibe-editor</span>
      </div>

      {menuBar}

      {projectRoot ? (
        <button
          type="button"
          className="topbar__project"
          title={projectRoot}
          aria-label={projectRoot}
        >
          {parentSlice ? (
            <>
              <span className="topbar__project-parent">{parentSlice}</span>
              <span className="topbar__project-sep">/</span>
            </>
          ) : null}
          <span className="topbar__project-name">{projectName}</span>
        </button>
      ) : null}

      <div className="topbar__spacer" data-tauri-drag-region />

      <button
        type="button"
        className="topbar__search"
        onClick={onOpenPalette}
        aria-label={t('toolbar.palette.title')}
      >
        <Search size={13} strokeWidth={1.9} className="topbar__search-icon" />
        <span className="topbar__search-hint">{t('topbar.searchHint')}</span>
        <span className="topbar__search-kbd">⌘K</span>
      </button>

      {status ? (
        <span className="topbar__status" title={status}>
          <span className="topbar__status-dot" aria-hidden="true" style={{ background: dotColor }} />
          <span className="topbar__status-text">{status}</span>
        </span>
      ) : null}

      {extraActions ? <div className="topbar__extra">{extraActions}</div> : null}

      {availableUpdate && onClickUpdate ? (
        <div className="topbar__icons">
          <button
            type="button"
            className="topbar__update"
            onClick={onClickUpdate}
            title={t('updater.button.title', { version: availableUpdate.version })}
            aria-label={t('updater.button.title', { version: availableUpdate.version })}
          >
            <ArrowDownToLine size={13} strokeWidth={2} />
            <span className="topbar__update-label">
              {t('updater.button.label', { version: availableUpdate.version })}
            </span>
          </button>
        </div>
      ) : null}

      {/* Issue #260 PR-2: カスタムタイトルバーのウィンドウ制御 (decorations: false の代替) */}
      <WindowControls />
    </div>
  );
}
