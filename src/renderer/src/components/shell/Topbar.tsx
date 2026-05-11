import { type ReactNode } from 'react';
import {
  Activity as ActivityIcon,
  ArrowDownToLine,
  Command as CommandIcon,
  RotateCw,
  Search,
  Sliders as SlidersIcon
} from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../stores/ui';
import type { AvailableUpdateInfo } from '../../lib/updater-check';
import { WindowControls } from './WindowControls';

interface TopbarProps {
  projectRoot: string;
  status: string;
  onRestart: () => void;
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
 * + ⌘K 検索トリガ + アイコンの 5 パート構成。
 */
export function Topbar({
  projectRoot,
  status,
  onRestart,
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

      <div className="topbar__icons">
        {availableUpdate && onClickUpdate ? (
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
        ) : null}
        <TopbarActivityToggle />
        <TopbarTweaksToggle />
        <button
          type="button"
          className="topbar__iconbtn"
          onClick={onRestart}
          title={t('toolbar.restart.title')}
          aria-label={t('toolbar.restart.title')}
        >
          <RotateCw size={14} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          className="topbar__iconbtn"
          onClick={onOpenPalette}
          title={t('toolbar.palette.title')}
          aria-label={t('toolbar.palette.title')}
        >
          <CommandIcon size={14} strokeWidth={1.9} />
        </button>
      </div>

      {/* Issue #260 PR-2: カスタムタイトルバーのウィンドウ制御 (decorations: false の代替) */}
      <WindowControls />
    </div>
  );
}

function TopbarActivityToggle(): JSX.Element {
  const activityOpen = useUiStore((s) => s.activityOpen);
  const toggleActivity = useUiStore((s) => s.toggleActivity);
  const t = useT();
  return (
    <button
      type="button"
      className={`topbar__iconbtn${activityOpen ? ' is-active' : ''}`}
      onClick={toggleActivity}
      title={t('activity.title')}
      aria-label={t('activity.title')}
      aria-pressed={activityOpen}
    >
      <ActivityIcon size={14} strokeWidth={1.9} />
    </button>
  );
}

function TopbarTweaksToggle(): JSX.Element {
  const tweaksOpen = useUiStore((s) => s.tweaksOpen);
  const toggleTweaks = useUiStore((s) => s.toggleTweaks);
  const t = useT();
  return (
    <button
      type="button"
      className={`topbar__iconbtn${tweaksOpen ? ' is-active' : ''}`}
      onClick={toggleTweaks}
      title={t('tweaks.open')}
      aria-label={t('tweaks.open')}
      aria-pressed={tweaksOpen}
    >
      <SlidersIcon size={14} strokeWidth={1.9} />
    </button>
  );
}
