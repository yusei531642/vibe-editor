import { GitBranch, RefreshCw } from 'lucide-react';
import type { GitStatus, GitFileChange } from '../../../types/shared';
import { useT } from '../lib/i18n';

interface ChangesPanelProps {
  status: GitStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenDiff: (file: GitFileChange) => void;
  onFileContextMenu: (e: React.MouseEvent, file: GitFileChange) => void;
  activeDiffPath: string | null;
}

function statusBadgeClass(file: GitFileChange): string {
  const tag = file.label.toLowerCase();
  if (tag.startsWith('add') || file.indexStatus === '?') return 'gitfile__badge--added';
  if (tag.startsWith('del')) return 'gitfile__badge--deleted';
  if (tag.startsWith('mod')) return 'gitfile__badge--modified';
  if (tag.startsWith('ren')) return 'gitfile__badge--renamed';
  if (tag.startsWith('con')) return 'gitfile__badge--conflict';
  return 'gitfile__badge--other';
}

function shortLabel(file: GitFileChange): string {
  if (file.indexStatus === '?' && file.worktreeStatus === '?') return 'U';
  if (file.label === 'Modified') return 'M';
  if (file.label === 'Added') return 'A';
  if (file.label === 'Deleted') return 'D';
  if (file.label === 'Renamed') return 'R';
  if (file.label === 'Conflict') return '!';
  return file.label[0] ?? '?';
}

export function ChangesPanel({
  status,
  loading,
  onRefresh,
  onOpenDiff,
  onFileContextMenu,
  activeDiffPath
}: ChangesPanelProps): JSX.Element {
  const t = useT();
  return (
    <div className="sidebar-view">
      <header className="sidebar-view__header">
        <div className="sidebar-view__meta">
          {status && status.ok && status.branch && (
            <span className="git-branch">
              <GitBranch size={11} strokeWidth={2} />
              {status.branch}
            </span>
          )}
          {status && status.ok && (
            <span className="git-count">
              {t('sidebar.filesChanged', { count: status.files.length })}
            </span>
          )}
        </div>
        <button
          type="button"
          className="sidebar__section-btn"
          onClick={onRefresh}
          title={t('sidebar.refresh')}
          aria-label={t('sidebar.refresh')}
        >
          <RefreshCw size={13} strokeWidth={2} />
        </button>
      </header>

      {loading && (
        <div className="skeleton-list" aria-label={t('sidebar.loading')} aria-busy="true">
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      )}

      {!loading && status && !status.ok && (
        <p className="sidebar__note sidebar__note--error">
          {status.error === 'Gitリポジトリではありません'
            ? t('sidebar.notGitRepo')
            : status.error}
        </p>
      )}

      {!loading && status && status.ok && status.files.length === 0 && (
        <p className="sidebar__note sidebar__note--dim">{t('sidebar.noChanges')}</p>
      )}

      {!loading && status && status.ok && status.files.length > 0 && (
        <ul className="gitfiles">
          {status.files.map((f) => {
            const isActive = activeDiffPath === f.path;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={`gitfile ${isActive ? 'is-active' : ''}`}
                  onClick={() => onOpenDiff(f)}
                  onContextMenu={(e) => onFileContextMenu(e, f)}
                  title={`${f.label}: ${f.path}`}
                >
                  <span className={`gitfile__badge ${statusBadgeClass(f)}`}>
                    {shortLabel(f)}
                  </span>
                  <span className="gitfile__path">{f.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
