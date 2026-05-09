import { memo, useEffect, useId, useMemo, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as DefaultFileIcon,
  FolderPlus,
  RefreshCw,
  X
} from 'lucide-react';
import type { FileNode } from '../../../types/shared';
import type { RecentFileEntry } from '../lib/hooks/use-file-tabs';
import { useT } from '../lib/i18n';
import { fileIcon, folderIcon } from '../lib/file-icon-color';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useToast } from '../lib/toast-context';
import { api } from '../lib/tauri-api';
import {
  KEY_SEP,
  dirKey,
  splitKey,
  useFileTreeState,
  type DirState
} from '../lib/filetree-state-context';

interface FileTreePanelProps {
  /** メインのプロジェクトルート(ターミナル/Git 等はこちら基準で動作する) */
  primaryRoot: string;
  /**
   * Issue #4: サイドバーに並べて表示する追加ルート。
   * primaryRoot と重複していても構わない呼び出し側で排除する(副作用避け)。
   */
  extraRoots: string[];
  activeFilePath: string | null;
  /** Issue #480: 最近開いたファイルの履歴 (新しい順) */
  recentFiles?: RecentFileEntry[];
  /** ファイルを開くときにどのルート配下かを明示する */
  onOpenFile: (rootPath: string, relPath: string) => void;
  onAddWorkspaceFolder: () => void;
  onRemoveWorkspaceFolder: (path: string) => void;
}

const shortName = (abs: string): string => {
  const parts = abs.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || abs;
};

export function FileTreePanel({
  primaryRoot,
  extraRoots,
  activeFilePath,
  recentFiles,
  onOpenFile,
  onAddWorkspaceFolder,
  onRemoveWorkspaceFolder
}: FileTreePanelProps): JSX.Element {
  const t = useT();
  // Issue #273: 展開状態 / 折り畳み / dir キャッシュは Provider に集約。
  // 同じ Provider を見ている Sidebar / FileTreeCard は同じ参照を持つので、
  // 一方でトグルした結果が他方に即時反映され、`update({ fileTreeExpanded })` の
  // last-writer-wins 上書きも起きない。
  const {
    dirs,
    expanded,
    collapsedRoots,
    toggleDir: ctxToggleDir,
    toggleRoot,
    loadDir,
    refreshAll: ctxRefreshAll,
    registerRoots,
    unregisterRoots
  } = useFileTreeState();

  /** Issue #251: ファイル右クリックで開く ContextMenu の表示状態 */
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; items: ContextMenuItem[] } | null
  >(null);
  const showToast = useToast();
  // Issue #273: 当該 instance を Provider に登録する一意 id。Sidebar と FileTreeCard が
  // 同居しても useId で生成された値は重複しない (React 18 の機能)。
  const instanceId = useId();

  /** 現在サイドバーに表示するルート一覧(primary + extras から重複除去)。
   *  Issue #129: 配列リテラルを毎レンダー作ると useEffect deps や子供 props が
   *  毎回新参照になるので useMemo で identity を安定化する。 */
  const roots = useMemo(
    () =>
      [primaryRoot, ...extraRoots].filter(
        (p, i, arr) => p && arr.indexOf(p) === i
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primaryRoot, extraRoots.join(KEY_SEP)]
  );

  // Issue #273 #3: 当該 instance の roots を Provider に登録。Provider 側で全 instance の
  // 和集合に含まれない expanded entry を prune する。unmount 時に解除して、UI 非表示中の
  // 過剰 prune を避ける。
  useEffect(() => {
    registerRoots(instanceId, roots);
    return () => unregisterRoots(instanceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, primaryRoot, extraRoots.join(KEY_SEP), registerRoots, unregisterRoots]);

  // ルート構成が変わったら、まだロードしていないルートの直下を自動ロード。
  // dirs キャッシュは Provider 共有なので、Sidebar と FileTreeCard を行き来しても
  // 既にロード済みのルートは再ロードされない (Issue #273 #4 にも貢献)。
  useEffect(() => {
    for (const root of roots) {
      const key = dirKey(root, '');
      if (!dirs.has(key)) {
        void loadDir(root, '');
      }
    }
    // dirs は Provider state なので毎回新参照だが、`dirs.has` の結果で
    // load 必要性を判定するので exhaustive-deps の警告は黙殺する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRoot, extraRoots.join(KEY_SEP), loadDir]);

  // Issue #250 + #273: 永続化された expanded を Provider 経由で受け取り、未ロードな
  // ものだけ load を queue に積む (Provider 内の concurrency-limited queue で発火)。
  // expanded を deps に入れると毎トグル再走するので、roots と loadDir のみ依存にする
  // (mount + ルート切替時のみ走る)。
  useEffect(() => {
    for (const key of expanded) {
      if (dirs.has(key)) continue;
      const split = splitKey(key);
      if (!split) continue;
      if (split.relPath !== '' && roots.includes(split.rootPath)) {
        void loadDir(split.rootPath, split.relPath);
      }
    }
    // expanded / dirs を意図的に deps から除外 (mount + roots 変動時のみ走る)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRoot, extraRoots.join(KEY_SEP), loadDir]);

  // Issue #480: recentFiles を rootPath+relPath -> rank (0始まり) のマップに変換。
  // rank 0 = 直近に開いたファイル, rank 1 = その前, ... (active は UI 側で優先)
  const recentRankMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!recentFiles) return map;
    for (let i = 0; i < recentFiles.length; i++) {
      const entry = recentFiles[i];
      map.set(`${entry.rootPath}${KEY_SEP}${entry.relPath}`, i);
    }
    return map;
  }, [recentFiles]);

  const toggleDir = useCallback(
    (rootPath: string, node: FileNode) => {
      if (!node.isDir) return;
      ctxToggleDir(rootPath, node.path);
    },
    [ctxToggleDir]
  );

  const refreshAll = useCallback(() => {
    ctxRefreshAll(roots);
  }, [ctxRefreshAll, roots]);

  // Issue #251: ファイル/ディレクトリ右クリックでパスコピー / エクスプローラ表示の
  // ContextMenu を開く。renderer 側のみで完結 (絶対パスは rootPath + relPath を結合)。
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, rootPath: string, node: FileNode) => {
      e.preventDefault();
      e.stopPropagation();
      // node.path は POSIX 区切り。Windows の絶対パスを作る場合のみ \ に置換する。
      const sep = rootPath.includes('\\') ? '\\' : '/';
      const absPath =
        node.path === ''
          ? rootPath
          : `${rootPath}${sep}${node.path.split('/').join(sep)}`;
      const relPath = node.path; // POSIX 区切りのまま
      const copy = (text: string): void => {
        navigator.clipboard
          .writeText(text)
          .then(() => showToast(t('toast.pathCopied'), { tone: 'info' }))
          .catch(() => showToast(t('toast.copyFailed'), { tone: 'error' }));
      };
      const items: ContextMenuItem[] = [
        {
          label: t('ctxMenu.copyAbsolutePath'),
          action: () => copy(absPath)
        },
        {
          label: t('ctxMenu.copyRelativePath'),
          action: () => copy(relPath || node.name),
          disabled: relPath === '',
          divider: true
        },
        {
          label: t('ctxMenu.copyFileName'),
          action: () => copy(node.name),
          divider: true
        },
        {
          label: t('ctxMenu.revealInFolder'),
          action: () => {
            void api.app.revealInFileManager(absPath).then((res) => {
              if (!res.ok) {
                showToast(t('toast.revealFailed'), { tone: 'error' });
              }
            });
          }
        }
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [showToast, t]
  );

  const handleRootContextMenu = useCallback(
    (e: React.MouseEvent, rootPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      const items: ContextMenuItem[] = [
        {
          label: t('workspace.remove'),
          action: () => onRemoveWorkspaceFolder(rootPath)
        }
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [onRemoveWorkspaceFolder, t]
  );

  const renderChildren = (
    rootPath: string,
    relPath: string,
    depth: number
  ): JSX.Element | null => {
    const state = dirs.get(dirKey(rootPath, relPath));
    if (!state) return null;
    if (state.loading && state.entries.length === 0) {
      return (
        <div className="filetree__loading" style={{ paddingLeft: 10 + depth * 12 }}>
          …
        </div>
      );
    }
    if (state.error) {
      return (
        <div className="filetree__error" style={{ paddingLeft: 10 + depth * 12 }}>
          {state.error}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div className="filetree__empty" style={{ paddingLeft: 10 + depth * 12 }}>
          —
        </div>
      );
    }
    return (
      <>
        {state.entries.map((node) => {
          const childKey = dirKey(rootPath, node.path);
          const isOpen = node.isDir && expanded.has(childKey);
          const childState: DirState | null = node.isDir
            ? dirs.get(childKey) ?? null
            : null;
          const isActive = !node.isDir && activeFilePath === node.path;
          // Issue #480: ファイルの recent ランクを取得 (-1 = 履歴なし)
          const recentRank = node.isDir
            ? -1
            : recentRankMap.get(`${rootPath}${KEY_SEP}${node.path}`) ?? -1;
          return (
            <FileTreeNode
              key={childKey}
              rootPath={rootPath}
              node={node}
              depth={depth}
              isOpen={isOpen}
              isActive={isActive}
              recentRank={recentRank}
              childState={childState}
              onToggle={toggleDir}
              onOpenFile={onOpenFile}
              onContextMenu={handleContextMenu}
              renderChildren={renderChildren}
            />
          );
        })}
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
                onContextMenu={(e) => handleRootContextMenu(e, root)}
              >
                <button
                  type="button"
                  className="filetree__root-toggle"
                  onClick={() => toggleRoot(root)}
                  aria-expanded={!collapsed}
                >
                  {isPrimary && <span className="filetree__root-dot" aria-hidden />}
                  {collapsed ? (
                    <ChevronRight size={12} strokeWidth={2} />
                  ) : (
                    <ChevronDown size={12} strokeWidth={2} />
                  )}
                  <span className="filetree__root-name">{shortName(root)}</span>
                </button>
                <button
                  type="button"
                  className="filetree__root-remove"
                  onClick={() => onRemoveWorkspaceFolder(root)}
                  title={t('workspace.remove')}
                  aria-label={t('workspace.remove')}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
              {!collapsed && renderChildren(root, '', 0)}
            </div>
          );
        })}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

interface FileTreeNodeProps {
  rootPath: string;
  node: FileNode;
  depth: number;
  isOpen: boolean;
  isActive: boolean;
  /**
   * Issue #480: 最近開いたファイルの順位 (0 = 直近, 1 = その前, ...)。
   * -1 は履歴に含まれていない。active と重なる場合は UI 側で active を優先する。
   */
  recentRank: number;
  /** 子ディレクトリの DirState (再レンダー判定用)。null は未読込 or ファイル */
  childState: DirState | null;
  onToggle: (rootPath: string, node: FileNode) => void;
  onOpenFile: (rootPath: string, relPath: string) => void;
  /** Issue #251: 右クリックメニュー要求 */
  onContextMenu: (e: React.MouseEvent, rootPath: string, node: FileNode) => void;
  renderChildren: (
    rootPath: string,
    relPath: string,
    depth: number
  ) => JSX.Element | null;
}

function FileTreeNodeImpl({
  rootPath,
  node,
  depth,
  isOpen,
  isActive,
  recentRank,
  onToggle,
  onOpenFile,
  onContextMenu,
  renderChildren
}: FileTreeNodeProps): JSX.Element {
  const fileIconDef = node.isDir ? undefined : fileIcon(node.name);
  const FileTypeIcon = fileIconDef?.Icon ?? DefaultFileIcon;
  const fileTypeColor = fileIconDef?.color;
  const folderDef = node.isDir ? folderIcon(node.name, isOpen) : undefined;

  const handleClick = (): void => {
    if (node.isDir) onToggle(rootPath, node);
    else onOpenFile(rootPath, node.path);
  };

  // Issue #18: 階層ごとのインデントガイドを background-image で描く。
  // 1px の縦線を 12px 間隔で depth 本だけ。深い階層でも視線が迷子にならない。
  const guideStyle: React.CSSProperties =
    depth > 0
      ? {
          paddingLeft: 4 + depth * 12,
          backgroundImage:
            'repeating-linear-gradient(to right, var(--filetree-guide, rgba(127,127,127,0.16)) 0 1px, transparent 1px 12px)',
          backgroundSize: `${depth * 12}px 100%`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: '4px 0'
        }
      : { paddingLeft: 4 };

  return (
    <>
      <button
        type="button"
        className={`filetree__row${isActive ? ' is-active' : ''}`}
        style={guideStyle}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, rootPath, node)}
      >
        {node.isDir && folderDef ? (
          <>
            <ChevronRight
              size={13}
              strokeWidth={2.25}
              className={`filetree__chevron${isOpen ? ' is-open' : ''}`}
            />
            <folderDef.Icon
              size={14}
              strokeWidth={2}
              fill="currentColor"
              fillOpacity={isOpen ? 0.22 : 0.18}
              className={`filetree__icon${isOpen ? ' filetree__icon--open' : ''}${folderDef.color ? ' filetree__icon--colored' : ''}`}
              style={folderDef.color ? { color: folderDef.color } : undefined}
              aria-hidden
            />
          </>
        ) : (
          <>
            <span className="filetree__chevron-spacer" />
            <FileTypeIcon
              size={14}
              strokeWidth={2}
              className="filetree__file-icon"
              style={fileTypeColor ? { color: fileTypeColor } : undefined}
              aria-hidden
            />
          </>
        )}
        <span
          className={
            'filetree__name' +
            // Issue #480: active でない最近ファイルに段階的な色クラスを付与
            (!isActive && recentRank >= 0
              ? recentRank === 0
                ? ' is-recent is-recent-1'
                : recentRank <= 2
                  ? ' is-recent is-recent-2'
                  : recentRank <= 5
                    ? ' is-recent is-recent-3'
                    : ' is-recent'
              : '')
          }
        >{node.name}</span>
      </button>
      {node.isDir && isOpen ? renderChildren(rootPath, node.path, depth + 1) : null}
    </>
  );
}

/**
 * Issue #129: React.memo で「親が再レンダーしても自分の入力 (node, isOpen, isActive,
 * childState など) が変わらない限り再レンダーしない」ようにする。
 * 親が expanded Set を新規生成しても、各ノードの isOpen は親側で計算してから
 * primitive boolean として渡しているので memo が安全に効く。
 * renderChildren は親が毎レンダー再生成するため、ここでは再レンダー判定から外す
 * (renderChildren 経由で開いた子供は依然として再帰的に再構築されるが、
 *  閉じているノード/葉は本 memo + props 比較で再レンダーをスキップできる)。
 */
const FileTreeNode = memo(FileTreeNodeImpl, (prev, next) => {
  return (
    prev.rootPath === next.rootPath &&
    prev.node === next.node &&
    prev.depth === next.depth &&
    prev.isOpen === next.isOpen &&
    prev.isActive === next.isActive &&
    prev.recentRank === next.recentRank &&
    prev.childState === next.childState &&
    prev.onToggle === next.onToggle &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onContextMenu === next.onContextMenu
    // renderChildren は意図的に比較しない (毎レンダー新参照になるが、
    // 開いているディレクトリは isOpen + childState の変化で再レンダーが
    // 既に走るので問題なし。閉じているノード/葉は早期 return できる)。
  );
});
