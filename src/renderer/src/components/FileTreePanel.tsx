import { useEffect, useState, useCallback } from 'react';
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw
} from 'lucide-react';
import type { FileNode } from '../../../types/shared';
import { useT } from '../lib/i18n';

interface FileTreePanelProps {
  projectRoot: string;
  activeFilePath: string | null;
  onOpenFile: (relPath: string) => void;
}

interface DirState {
  loading: boolean;
  error: string | null;
  entries: FileNode[];
}

export function FileTreePanel({
  projectRoot,
  activeFilePath,
  onOpenFile
}: FileTreePanelProps): JSX.Element {
  const t = useT();
  /** 展開済みディレクトリのキャッシュ。key = 相対パス('' がルート) */
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

  const loadDir = useCallback(
    async (relPath: string): Promise<void> => {
      if (!projectRoot) return;
      // preload が古いと window.api.files 未定義 → 案内メッセージを出す
      if (!window.api.files) {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(relPath, {
            loading: false,
            error: 'アプリを再起動してください（preload 更新のため）',
            entries: []
          });
          return next;
        });
        return;
      }
      setDirs((prev) => {
        const next = new Map(prev);
        next.set(relPath, {
          loading: true,
          error: null,
          entries: prev.get(relPath)?.entries ?? []
        });
        return next;
      });
      try {
        const res = await window.api.files.list(projectRoot, relPath);
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(relPath, {
            loading: false,
            error: res.ok ? null : res.error ?? 'error',
            entries: res.entries
          });
          return next;
        });
      } catch (err) {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(relPath, {
            loading: false,
            error: String(err),
            entries: []
          });
          return next;
        });
      }
    },
    [projectRoot]
  );

  // ルートをプロジェクト切替時にロード
  useEffect(() => {
    if (!projectRoot) return;
    setDirs(new Map());
    setExpanded(new Set(['']));
    void loadDir('');
  }, [projectRoot, loadDir]);

  const toggleDir = useCallback(
    (node: FileNode) => {
      if (!node.isDir) return;
      const isOpen = expanded.has(node.path);
      if (isOpen) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(node.path);
          return next;
        });
        return;
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(node.path);
        return next;
      });
      if (!dirs.has(node.path)) {
        void loadDir(node.path);
      }
    },
    [expanded, dirs, loadDir]
  );

  const refresh = useCallback(() => {
    // 展開済みをすべて再ロード
    for (const path of expanded) {
      void loadDir(path);
    }
  }, [expanded, loadDir]);

  const renderChildren = (relPath: string, depth: number): JSX.Element | null => {
    const state = dirs.get(relPath);
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
            key={node.path}
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
        <span className="filetree__root">
          {projectRoot.split(/[\\/]/).pop() ?? projectRoot}
        </span>
        <button
          type="button"
          className="filetree__refresh"
          onClick={refresh}
          title={t('filetree.refresh')}
          aria-label="refresh"
        >
          <RefreshCw size={12} strokeWidth={1.75} />
        </button>
      </div>
      <div className="filetree__body">{renderChildren('', 0)}</div>
    </div>
  );
}

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  dirs: Map<string, DirState>;
  activeFilePath: string | null;
  onToggle: (node: FileNode) => void;
  onOpenFile: (path: string) => void;
  renderChildren: (relPath: string, depth: number) => JSX.Element | null;
}

function FileTreeNode({
  node,
  depth,
  expanded,
  activeFilePath,
  onToggle,
  onOpenFile,
  renderChildren
}: FileTreeNodeProps): JSX.Element {
  const isOpen = expanded.has(node.path);
  const isActive = !node.isDir && activeFilePath === node.path;

  const handleClick = (): void => {
    if (node.isDir) onToggle(node);
    else onOpenFile(node.path);
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
      {node.isDir && isOpen ? renderChildren(node.path, depth + 1) : null}
    </>
  );
}
