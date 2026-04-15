import { useEffect, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  X
} from 'lucide-react';
import type { FileNode } from '../../../types/shared';
import { useT } from '../lib/i18n';

interface FileTreePanelProps {
  /** メインのプロジェクトルート(ターミナル/Git 等はこちら基準で動作する) */
  primaryRoot: string;
  /**
   * Issue #4: サイドバーに並べて表示する追加ルート。
   * primaryRoot と重複していても構わない呼び出し側で排除する(副作用避け)。
   */
  extraRoots: string[];
  activeFilePath: string | null;
  /** ファイルを開くときにどのルート配下かを明示する */
  onOpenFile: (rootPath: string, relPath: string) => void;
  onAddWorkspaceFolder: () => void;
  onRemoveWorkspaceFolder: (path: string) => void;
}

interface DirState {
  loading: boolean;
  error: string | null;
  entries: FileNode[];
}

/** (rootPath, relPath) を一意キーに変換。Map のキーにする */
const dirKey = (rootPath: string, relPath: string): string =>
  `${rootPath}\0${relPath}`;

const shortName = (abs: string): string => {
  const parts = abs.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || abs;
};

export function FileTreePanel({
  primaryRoot,
  extraRoots,
  activeFilePath,
  onOpenFile,
  onAddWorkspaceFolder,
  onRemoveWorkspaceFolder
}: FileTreePanelProps): JSX.Element {
  const t = useT();
  /**
   * 全ルート共通のディレクトリキャッシュ。
   * key = `${rootPath}\0${relPath}` ('' がそのルートの直下)
   */
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  /** 展開済みディレクトリ集合(同じ key 形式) */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** 折り畳み状態のルート集合。primary は初期展開、extra はユーザー操作に委ねる */
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());

  /** 現在サイドバーに表示するルート一覧(primary + extras から重複除去) */
  const roots = [primaryRoot, ...extraRoots].filter(
    (p, i, arr) => p && arr.indexOf(p) === i
  );

  const loadDir = useCallback(
    async (rootPath: string, relPath: string): Promise<void> => {
      if (!rootPath) return;
      if (!window.api.files) {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(dirKey(rootPath, relPath), {
            loading: false,
            error: 'アプリを再起動してください（preload 更新のため）',
            entries: []
          });
          return next;
        });
        return;
      }
      const key = dirKey(rootPath, relPath);
      setDirs((prev) => {
        const next = new Map(prev);
        next.set(key, {
          loading: true,
          error: null,
          entries: prev.get(key)?.entries ?? []
        });
        return next;
      });
      try {
        const res = await window.api.files.list(rootPath, relPath);
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(key, {
            loading: false,
            error: res.ok ? null : res.error ?? 'error',
            entries: res.entries
          });
          return next;
        });
      } catch (err) {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(key, {
            loading: false,
            error: String(err),
            entries: []
          });
          return next;
        });
      }
    },
    []
  );

  // ルート構成が変わったら、まだロードしていないルートの直下を自動ロード。
  // 既にキャッシュ済みのルートは触らず(折り畳みや展開状態を保持)。
  useEffect(() => {
    for (const root of roots) {
      const key = dirKey(root, '');
      if (!dirs.has(key)) {
        void loadDir(root, '');
      }
    }
    // 削除されたルートのキャッシュは掃除する
    setDirs((prev) => {
      const validPrefixes = new Set(roots.map((r) => `${r}\0`));
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        const hit = Array.from(validPrefixes).some((p) => key.startsWith(p));
        if (!hit) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // roots は毎回新しい配列なので primaryRoot + extraRoots 依存にする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRoot, extraRoots.join('\u0001'), loadDir]);

  const toggleDir = useCallback(
    (rootPath: string, node: FileNode) => {
      if (!node.isDir) return;
      const key = dirKey(rootPath, node.path);
      const isOpen = expanded.has(key);
      if (isOpen) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        return;
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      if (!dirs.has(key)) {
        void loadDir(rootPath, node.path);
      }
    },
    [expanded, dirs, loadDir]
  );

  const refreshAll = useCallback(() => {
    // 展開済みと各ルート直下を再ロード
    for (const root of roots) {
      void loadDir(root, '');
    }
    for (const key of expanded) {
      const [rootPath, relPath] = key.split('\0');
      if (rootPath) void loadDir(rootPath, relPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, loadDir, primaryRoot, extraRoots.join('\u0001')]);

  const toggleRoot = useCallback((rootPath: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  }, []);

  const renderChildren = (
    rootPath: string,
    relPath: string,
    depth: number
  ): JSX.Element | null => {
    const state = dirs.get(dirKey(rootPath, relPath));
    if (!state) return null;
    if (state.loading && state.entries.length === 0) {
      return (
        <div className="filetree__loading" style={{ paddingLeft: 12 + depth * 14 }}>
          …
        </div>
      );
    }
    if (state.error) {
      return (
        <div className="filetree__error" style={{ paddingLeft: 12 + depth * 14 }}>
          {state.error}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div className="filetree__empty" style={{ paddingLeft: 12 + depth * 14 }}>
          —
        </div>
      );
    }
    return (
      <>
        {state.entries.map((node) => (
          <FileTreeNode
            key={dirKey(rootPath, node.path)}
            rootPath={rootPath}
            node={node}
            depth={depth}
            expanded={expanded}
            dirs={dirs}
            activeFilePath={activeFilePath}
            onToggle={toggleDir}
            onOpenFile={onOpenFile}
            renderChildren={renderChildren}
          />
        ))}
      </>
    );
  };

  return (
    <div className="filetree">
      <div className="filetree__header">
        <span className="filetree__root">{t('workspace.roots')}</span>
        <button
          type="button"
          className="filetree__refresh"
          onClick={onAddWorkspaceFolder}
          title={t('workspace.add')}
          aria-label={t('workspace.add')}
        >
          <FolderPlus size={12} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="filetree__refresh"
          onClick={refreshAll}
          title={t('filetree.refresh')}
          aria-label="refresh"
        >
          <RefreshCw size={12} strokeWidth={1.75} />
        </button>
      </div>
      <div className="filetree__body">
        {roots.length === 0 && (
          <div className="filetree__empty" style={{ paddingLeft: 12 }}>
            —
          </div>
        )}
        {roots.map((root) => {
          const collapsed = collapsedRoots.has(root);
          const isPrimary = root === primaryRoot;
          return (
            <div key={root} className="filetree__root-group">
              <div
                className={`filetree__root-header${isPrimary ? ' is-primary' : ''}`}
                title={root}
              >
                <button
                  type="button"
                  className="filetree__root-toggle"
                  onClick={() => toggleRoot(root)}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? (
                    <ChevronRight size={12} strokeWidth={2} />
                  ) : (
                    <ChevronDown size={12} strokeWidth={2} />
                  )}
                  <span className="filetree__root-name">{shortName(root)}</span>
                </button>
                {!isPrimary && (
                  <button
                    type="button"
                    className="filetree__root-remove"
                    onClick={() => onRemoveWorkspaceFolder(root)}
                    title={t('workspace.remove')}
                    aria-label={t('workspace.remove')}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                )}
              </div>
              {!collapsed && renderChildren(root, '', 0)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface FileTreeNodeProps {
  rootPath: string;
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  dirs: Map<string, DirState>;
  activeFilePath: string | null;
  onToggle: (rootPath: string, node: FileNode) => void;
  onOpenFile: (rootPath: string, relPath: string) => void;
  renderChildren: (
    rootPath: string,
    relPath: string,
    depth: number
  ) => JSX.Element | null;
}

function FileTreeNode({
  rootPath,
  node,
  depth,
  expanded,
  activeFilePath,
  onToggle,
  onOpenFile,
  renderChildren
}: FileTreeNodeProps): JSX.Element {
  const isOpen = expanded.has(dirKey(rootPath, node.path));
  const isActive = !node.isDir && activeFilePath === node.path;

  const handleClick = (): void => {
    if (node.isDir) onToggle(rootPath, node);
    else onOpenFile(rootPath, node.path);
  };

  return (
    <>
      <button
        type="button"
        className={`filetree__row${isActive ? ' is-active' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={handleClick}
      >
        {node.isDir ? (
          <>
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={`filetree__chevron${isOpen ? ' is-open' : ''}`}
            />
            {isOpen ? (
              <FolderOpen size={13} strokeWidth={1.75} className="filetree__icon" />
            ) : (
              <Folder size={13} strokeWidth={1.75} className="filetree__icon" />
            )}
          </>
        ) : (
          <>
            <span className="filetree__chevron-spacer" />
            <FileIcon size={13} strokeWidth={1.75} className="filetree__icon" />
          </>
        )}
        <span className="filetree__name">{node.name}</span>
      </button>
      {node.isDir && isOpen ? renderChildren(rootPath, node.path, depth + 1) : null}
    </>
  );
}
