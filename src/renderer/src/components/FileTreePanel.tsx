import { memo, useEffect, useMemo, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as DefaultFileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  X
} from 'lucide-react';
import type { FileNode } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { fileIcon } from '../lib/file-icon-color';

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
  /**
   * Issue #250: 永続化された展開状態の初期値。
   * lazy 初期化のためマウント時の値だけが使われる (再レンダーでは無視される)。
   */
  initialExpanded?: Set<string>;
  /** Issue #250: 永続化された折り畳み済みルートの初期値 */
  initialCollapsedRoots?: Set<string>;
  /** Issue #250: 状態変化時の永続化コールバック (親で settings に保存) */
  onPersistState?: (state: { expanded: Set<string>; collapsedRoots: Set<string> }) => void;
}

interface DirState {
  loading: boolean;
  error: string | null;
  entries: FileNode[];
}

/**
 * (rootPath, relPath) を一意キーに変換。Map のキーにする。
 * 区切りには NUL 文字を使う (パス内に出現しないため衝突しない)。
 */
const KEY_SEP = '\0';
const dirKey = (rootPath: string, relPath: string): string =>
  `${rootPath}${KEY_SEP}${relPath}`;

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
  onRemoveWorkspaceFolder,
  initialExpanded,
  initialCollapsedRoots,
  onPersistState
}: FileTreePanelProps): JSX.Element {
  const t = useT();
  /**
   * 全ルート共通のディレクトリキャッシュ。
   * key = `${rootPath}\0${relPath}` ('' がそのルートの直下)
   */
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  /** 展開済みディレクトリ集合(同じ key 形式) */
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded ?? new Set());
  /** 折り畳み状態のルート集合。primary は初期展開、extra はユーザー操作に委ねる */
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(
    () => initialCollapsedRoots ?? new Set()
  );

  /** 現在サイドバーに表示するルート一覧(primary + extras から重複除去)。
   *  Issue #129: 配列リテラルを毎レンダー作ると useEffect deps や子供 props が
   *  毎回新参照になるので useMemo で identity を安定化する。 */
  const roots = useMemo(
    () =>
      [primaryRoot, ...extraRoots].filter(
        (p, i, arr) => p && arr.indexOf(p) === i
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primaryRoot, extraRoots.join('')]
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

  // Issue #250: 永続化された expanded から (initialExpanded として) 復元した
  // ディレクトリを dirs キャッシュに非同期で読み込む。toggleDir 経由でない展開
  // 状態 = 復元時のみ意味があり、通常の操作では toggleDir 内で loadDir が呼ばれる。
  // expanded を deps に入れると毎トグル再走するので、roots と loadDir のみ依存にする
  // (mount + ルート切替時に 1 回だけ走る)。
  useEffect(() => {
    for (const key of expanded) {
      if (dirs.has(key)) continue;
      const sep = key.indexOf(KEY_SEP);
      if (sep <= 0) continue;
      const rootPath = key.slice(0, sep);
      const relPath = key.slice(sep + 1);
      // 永続化値に他プロジェクトの root が混在することを防ぐため、現在の roots に
      // 含まれているもののみ load する。relPath が '' のものはルート直下なので
      // 上の useEffect が読み込むためここでは無視。
      if (relPath !== '' && roots.includes(rootPath)) {
        void loadDir(rootPath, relPath);
      }
    }
    // expanded を意図的に deps から除外 (mount + roots 変動時のみ走る)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRoot, extraRoots.join(KEY_SEP), loadDir]);

  const toggleDir = useCallback(
    (rootPath: string, node: FileNode) => {
      if (!node.isDir) return;
      const key = dirKey(rootPath, node.path);
      const wasOpen = expanded.has(key);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onPersistState?.({ expanded: next, collapsedRoots });
        return next;
      });
      if (!wasOpen && !dirs.has(key)) {
        void loadDir(rootPath, node.path);
      }
    },
    [expanded, collapsedRoots, dirs, loadDir, onPersistState]
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

  const toggleRoot = useCallback(
    (rootPath: string) => {
      setCollapsedRoots((prev) => {
        const next = new Set(prev);
        if (next.has(rootPath)) next.delete(rootPath);
        else next.add(rootPath);
        onPersistState?.({ expanded, collapsedRoots: next });
        return next;
      });
    },
    [expanded, onPersistState]
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
          const childState = node.isDir ? dirs.get(childKey) ?? null : null;
          const isActive = !node.isDir && activeFilePath === node.path;
          return (
            <FileTreeNode
              key={childKey}
              rootPath={rootPath}
              node={node}
              depth={depth}
              isOpen={isOpen}
              isActive={isActive}
              childState={childState}
              onToggle={toggleDir}
              onOpenFile={onOpenFile}
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
  isOpen: boolean;
  isActive: boolean;
  /** 子ディレクトリの DirState (再レンダー判定用)。null は未読込 or ファイル */
  childState: DirState | null;
  onToggle: (rootPath: string, node: FileNode) => void;
  onOpenFile: (rootPath: string, relPath: string) => void;
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
  onToggle,
  onOpenFile,
  renderChildren
}: FileTreeNodeProps): JSX.Element {
  const fileIconDef = node.isDir ? undefined : fileIcon(node.name);
  const FileTypeIcon = fileIconDef?.Icon ?? DefaultFileIcon;
  const fileTypeColor = fileIconDef?.color;

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
      >
        {node.isDir ? (
          <>
            <ChevronRight
              size={13}
              strokeWidth={2.25}
              className={`filetree__chevron${isOpen ? ' is-open' : ''}`}
            />
            {isOpen ? (
              <FolderOpen
                size={14}
                strokeWidth={2}
                fill="currentColor"
                fillOpacity={0.22}
                className="filetree__icon filetree__icon--open"
              />
            ) : (
              <Folder
                size={14}
                strokeWidth={2}
                fill="currentColor"
                fillOpacity={0.18}
                className="filetree__icon"
              />
            )}
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
        <span className="filetree__name">{node.name}</span>
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
    prev.childState === next.childState &&
    prev.onToggle === next.onToggle &&
    prev.onOpenFile === next.onOpenFile
    // renderChildren は意図的に比較しない (毎レンダー新参照になるが、
    // 開いているディレクトリは isOpen + childState の変化で再レンダーが
    // 既に走るので問題なし。閉じているノード/葉は早期 return できる)。
  );
});
