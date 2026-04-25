import {
  Activity as ActivityIcon,
  Command as CommandIcon,
  RotateCw,
  Search,
  Sliders as SlidersIcon
} from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../stores/ui';

interface TopbarProps {
  projectRoot: string;
  status: string;
  onRestart: () => void;
  onOpenPalette: () => void;
  userInitial?: string;
}

/**
 * Redesign shell の上端バー (44px)。
 * Claude Design バンドル "vibe-editor Redesign" の .topbar セクションを
 * Tauri アプリ向けに移植。ブランドドット + プロジェクトクラム + モードピル
 * + ⌘K 検索トリガ + アイコン + ユーザーアバター の 6 パート構成。
 */
export function Topbar({
  projectRoot,
  status,
  onRestart,
  onOpenPalette,
  userInitial = 'U'
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
    <div className="topbar" role="banner">
      <div className="topbar__brand" title="vibe-editor">
        <img
          className="topbar__brand-logo"
          src="/vibe-editor.png"
          alt="vibe-editor"
          draggable={false}
        />
        <span>vibe-editor</span>
      </div>

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

      <div className="topbar__spacer" />

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

      <div className="topbar__icons">
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

      <div className="topbar__user" aria-label="user">
        {userInitial.slice(0, 1).toUpperCase()}
      </div>
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
