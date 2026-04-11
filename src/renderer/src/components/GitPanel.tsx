import type { GitStatus, GitFileChange } from '../../../types/shared';

interface GitPanelProps {
  status: GitStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenDiff: (file: GitFileChange) => void;
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

export function GitPanel({
  status,
  loading,
  onRefresh,
  onOpenDiff,
  activeDiffPath
}: GitPanelProps): JSX.Element {
  return (
    <section className="sidebar__section">
      <header className="sidebar__section-header">
        <h2>Git 変更</h2>
        <button
          type="button"
          className="sidebar__section-btn"
          onClick={onRefresh}
          title="更新"
        >
          ⟳
        </button>
      </header>

      {loading && <p className="sidebar__note">読み込み中…</p>}

      {!loading && status && !status.ok && (
        <p className="sidebar__note sidebar__note--error">{status.error}</p>
      )}

      {!loading && status && status.ok && (
        <>
          <p className="sidebar__note">
            {status.branch && <span className="git-branch">⎇ {status.branch}</span>}
            <span className="git-count">{status.files.length} ファイル変更</span>
          </p>
          {status.files.length === 0 ? (
            <p className="sidebar__note sidebar__note--dim">変更なし</p>
          ) : (
            <ul className="gitfiles">
              {status.files.map((f) => {
                const isActive = activeDiffPath === f.path;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={`gitfile ${isActive ? 'is-active' : ''}`}
                      onClick={() => onOpenDiff(f)}
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
        </>
      )}
    </section>
  );
}
