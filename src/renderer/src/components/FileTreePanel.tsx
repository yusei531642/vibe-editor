import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as DefaultFileIcon,
  FilePlus,
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

// Issue #592: VS Code 互換 cut / copy clipboard。サイドバーと FileTreeCard で共有するため
// module-level に置く。subscribe で UI を再描画する軽量 pub-sub。
type FileTreeClipboard = {
  rootPath: string;
  relPath: string;
  isDir: boolean;
  /** 'cut' は paste 後に元を消す (move)、'copy' は元を残す (copy)。 */
  mode: 'cut' | 'copy';
};
let clipboardState: FileTreeClipboard | null = null;
const clipboardListeners = new Set<() => void>();
const setClipboard = (next: FileTreeClipboard | null): void => {
  clipboardState = next;
  for (const fn of clipboardListeners) fn();
};
const getClipboard = (): FileTreeClipboard | null => clipboardState;

/** Issue #592: 親ディレクトリの entries にぶつからない basename を作る。
 *  `foo.txt` → 衝突したら `foo.copy.txt` → `foo.copy 2.txt` → `foo.copy 3.txt` …
 *  拡張子無しなら末尾に `.copy` を付けるだけ。先頭ドットファイル (.gitignore 等) は
 *  拡張子と見なさない。 */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const dotIdx = base.lastIndexOf('.');
  const hasExt = dotIdx > 0;
  const stem = hasExt ? base.slice(0, dotIdx) : base;
  const ext = hasExt ? base.slice(dotIdx) : '';
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '.copy' : `.copy ${n}`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 1000 回衝突は事実上ありえないが、無限ループを避けるため timestamp を足す
  return `${stem}.copy.${Date.now()}${ext}`;
}

/** parent 相対パスを basename と join する (POSIX 区切り)。 */
function joinRel(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent.replace(/\/$/, '')}/${name}`;
}

/** 相対パスから親ディレクトリ部分 (POSIX) を取り出す。`a/b/c` → `a/b`、`a` → ''。 */
function parentOfRel(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.slice(0, idx) : '';
}

/** 相対パスから basename を取り出す。 */
function basenameOfRel(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}

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

/** Issue #592: インライン入力 (新規ファイル / 新規フォルダ / リネーム) の状態。 */
type InlineInputState = {
  rootPath: string;
  /** 入力 row を表示する親ディレクトリの相対パス。'' でルート直下。 */
  parentRel: string;
  mode: 'create-file' | 'create-folder' | 'rename';
  /** rename のときの旧 basename。create のときは空文字。 */
  initialName: string;
  /** rename のときの旧相対パス。create のときは undefined。 */
  originalRelPath?: string;
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

  // Issue #592: VS Code 互換のインライン入力 (新規ファイル / フォルダ / リネーム)。
  const [inlineInput, setInlineInput] = useState<InlineInputState | null>(null);

  // Issue #592: clipboard の購読。setClipboard の度に再描画して paste 項目の disabled を更新。
  const [, forceRender] = useState(0);
  useEffect(() => {
    const fn = (): void => forceRender((n) => n + 1);
    clipboardListeners.add(fn);
    return () => {
      clipboardListeners.delete(fn);
    };
  }, []);

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

  /** Issue #592: 1 ディレクトリだけ再 list して キャッシュを更新する。 */
  const refreshDir = useCallback(
    (rootPath: string, relPath: string) => {
      void loadDir(rootPath, relPath);
    },
    [loadDir]
  );

  /** Issue #592: ファイル操作のエラーをトーストで通知する共通ヘルパ。 */
  const showOpError = useCallback(
    (error: string | undefined) => {
      showToast(t('toast.fileOpFailed', { error: error ?? 'unknown' }), { tone: 'error' });
    },
    [showToast, t]
  );

  /** Issue #592: 新規ファイル/フォルダ作成の inline input を開く。
   *  対象が未展開ディレクトリなら先に展開してから入力欄を出す。 */
  const beginCreate = useCallback(
    (rootPath: string, parentRel: string, kind: 'file' | 'folder') => {
      if (parentRel !== '') {
        const parentKey = dirKey(rootPath, parentRel);
        if (!expanded.has(parentKey)) {
          ctxToggleDir(rootPath, parentRel);
        }
      }
      setInlineInput({
        rootPath,
        parentRel,
        mode: kind === 'file' ? 'create-file' : 'create-folder',
        initialName: ''
      });
    },
    [ctxToggleDir, expanded]
  );

  /** Issue #592: 既存 entry のリネーム inline input を開く。 */
  const beginRename = useCallback((rootPath: string, relPath: string) => {
    setInlineInput({
      rootPath,
      parentRel: parentOfRel(relPath),
      mode: 'rename',
      initialName: basenameOfRel(relPath),
      originalRelPath: relPath
    });
  }, []);

  /** Issue #592: inline input の確定処理。失敗時は error toast を出して input は閉じない。 */
  const submitInlineInput = useCallback(
    async (raw: string) => {
      if (!inlineInput) return;
      const trimmed = raw.trim();
      if (!trimmed) {
        setInlineInput(null);
        return;
      }
      const { rootPath, parentRel, mode, originalRelPath } = inlineInput;
      try {
        if (mode === 'create-file') {
          const res = await api.files.create(rootPath, parentRel, trimmed, false);
          if (!res.ok) {
            showOpError(res.error);
            return;
          }
          showToast(t('toast.fileCreated', { name: trimmed }), { tone: 'success' });
          refreshDir(rootPath, parentRel);
          // VS Code と同じ挙動: 新規ファイルはエディタで開く
          onOpenFile(rootPath, joinRel(parentRel, trimmed));
        } else if (mode === 'create-folder') {
          const res = await api.files.createDir(rootPath, parentRel, trimmed);
          if (!res.ok) {
            showOpError(res.error);
            return;
          }
          showToast(t('toast.folderCreated', { name: trimmed }), { tone: 'success' });
          refreshDir(rootPath, parentRel);
        } else if (mode === 'rename' && originalRelPath !== undefined) {
          if (basenameOfRel(originalRelPath) === trimmed) {
            setInlineInput(null);
            return;
          }
          const res = await api.files.rename(
            rootPath,
            originalRelPath,
            parentRel,
            trimmed,
            false
          );
          if (!res.ok) {
            showOpError(res.error);
            return;
          }
          showToast(
            t('toast.fileRenamed', {
              from: basenameOfRel(originalRelPath),
              to: trimmed
            }),
            { tone: 'success' }
          );
          refreshDir(rootPath, parentRel);
        }
        setInlineInput(null);
      } catch (e) {
        showOpError(String(e));
      }
    },
    [inlineInput, onOpenFile, refreshDir, showOpError, showToast, t]
  );

  /** Issue #592: 削除確定処理。最初は trash 経路、失敗時は完全削除を確認するフォールバック。 */
  const handleDelete = useCallback(
    async (rootPath: string, node: FileNode) => {
      if (!node.path) return; // root 削除は禁止
      const baseKey = node.isDir
        ? 'filetree.confirmDeleteFolder'
        : 'filetree.confirmDeleteFile';
      if (!window.confirm(t(baseKey, { name: node.name }))) return;
      const res = await api.files.delete(rootPath, node.path, false);
      if (res.ok) {
        showToast(t('toast.fileDeleted', { name: node.name }), { tone: 'success' });
        refreshDir(rootPath, parentOfRel(node.path));
        return;
      }
      // ゴミ箱が使えない環境 (XDG ゴミ箱が無い Linux 等) → 完全削除に fallback
      if (window.confirm(t('filetree.confirmDeletePermanent', { name: node.name }))) {
        const r2 = await api.files.delete(rootPath, node.path, true);
        if (r2.ok) {
          showToast(t('toast.fileDeleted', { name: node.name }), { tone: 'success' });
          refreshDir(rootPath, parentOfRel(node.path));
        } else {
          showOpError(r2.error);
        }
      }
    },
    [refreshDir, showOpError, showToast, t]
  );

  /** Issue #592: cut / copy で clipboard に積む。paste 時に rename or copy を判定する。 */
  const handleCutCopy = useCallback(
    (rootPath: string, node: FileNode, mode: 'cut' | 'copy') => {
      if (!node.path) return; // root を cut/copy しない
      setClipboard({ rootPath, relPath: node.path, isDir: node.isDir, mode });
    },
    []
  );

  /** Issue #592: paste 実行。clipboard が `cut` なら files.rename (move)、
   *  `copy` なら files.copy (再帰コピー) を呼ぶ。同名衝突時は uniqueName 化。
   *  `targetParentRel` は paste 先のディレクトリ相対パス (空文字でルート)。 */
  const handlePaste = useCallback(
    async (rootPath: string, targetParentRel: string) => {
      const cb = getClipboard();
      if (!cb) {
        showToast(t('toast.fileOpClipboardEmpty'), { tone: 'warning' });
        return;
      }
      // ルート跨ぎは禁止 (異なるルート間は IPC が複雑になるので将来対応)
      if (cb.rootPath !== rootPath) {
        showOpError('cannot paste across roots');
        return;
      }
      // 自分自身もしくは子孫への paste は禁止
      if (
        cb.relPath === targetParentRel ||
        targetParentRel.startsWith(`${cb.relPath}/`)
      ) {
        showOpError('cannot paste into the source itself or its descendant');
        return;
      }
      const sourceName = basenameOfRel(cb.relPath);
      const targetState = dirs.get(dirKey(rootPath, targetParentRel));
      const taken = new Set<string>(
        (targetState?.entries ?? []).map((e) => e.name)
      );
      const finalName = uniqueName(sourceName, taken);

      const res =
        cb.mode === 'cut'
          ? await api.files.rename(rootPath, cb.relPath, targetParentRel, finalName, false)
          : await api.files.copy(rootPath, cb.relPath, targetParentRel, finalName, false);
      if (!res.ok) {
        showOpError(res.error);
        return;
      }
      showToast(
        t(cb.mode === 'cut' ? 'toast.fileMoved' : 'toast.fileCopied', { name: sourceName }),
        { tone: 'success' }
      );
      refreshDir(rootPath, targetParentRel);
      if (cb.mode === 'cut') {
        // 元の親も refresh (entry が消えるため)
        refreshDir(rootPath, parentOfRel(cb.relPath));
        setClipboard(null);
      }
    },
    [dirs, refreshDir, showOpError, showToast, t]
  );

  /** Issue #592: 同じディレクトリに `<base>.copy` (もしくは衝突回避サフィックス付) でコピー。 */
  const handleDuplicate = useCallback(
    async (rootPath: string, node: FileNode) => {
      if (!node.path) return;
      const parent = parentOfRel(node.path);
      const targetState = dirs.get(dirKey(rootPath, parent));
      const taken = new Set<string>(
        (targetState?.entries ?? []).map((e) => e.name)
      );
      // 元の名前は taken に含まれているので uniqueName が `.copy` を必ず付ける
      const finalName = uniqueName(node.name, taken);
      const res = await api.files.copy(rootPath, node.path, parent, finalName, false);
      if (!res.ok) {
        showOpError(res.error);
        return;
      }
      showToast(t('toast.fileCopied', { name: node.name }), { tone: 'success' });
      refreshDir(rootPath, parent);
    },
    [dirs, refreshDir, showOpError, showToast, t]
  );

  // Issue #251 + #592: ファイル/ディレクトリ右クリックメニューを開く。
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, rootPath: string, node: FileNode) => {
      e.preventDefault();
      e.stopPropagation();
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
      const cb = getClipboard();
      // paste 先は: ディレクトリなら自身、ファイルならその親ディレクトリ。
      const pasteTarget = node.isDir ? relPath : parentOfRel(relPath);
      const items: ContextMenuItem[] = [];
      // 新規作成: ディレクトリ右クリックのみ。Files の場合は親ディレクトリ。
      const createParent = node.isDir ? relPath : parentOfRel(relPath);
      items.push({
        label: t('ctxMenu.newFile'),
        action: () => beginCreate(rootPath, createParent, 'file')
      });
      items.push({
        label: t('ctxMenu.newFolder'),
        action: () => beginCreate(rootPath, createParent, 'folder'),
        divider: true
      });
      // Cut / Copy / Paste / Duplicate / Rename / Delete
      items.push({
        label: t('ctxMenu.cut'),
        action: () => handleCutCopy(rootPath, node, 'cut'),
        disabled: !relPath
      });
      items.push({
        label: t('ctxMenu.copy'),
        action: () => handleCutCopy(rootPath, node, 'copy'),
        disabled: !relPath
      });
      items.push({
        label: t('ctxMenu.paste'),
        action: () => void handlePaste(rootPath, pasteTarget),
        disabled: !cb || cb.rootPath !== rootPath
      });
      items.push({
        label: t('ctxMenu.duplicate'),
        action: () => void handleDuplicate(rootPath, node),
        disabled: !relPath,
        divider: true
      });
      items.push({
        label: t('ctxMenu.rename'),
        action: () => beginRename(rootPath, relPath),
        disabled: !relPath
      });
      items.push({
        label: t('ctxMenu.delete'),
        action: () => void handleDelete(rootPath, node),
        disabled: !relPath,
        divider: true
      });
      // 既存の Issue #251 機能 (パスコピー / Reveal)
      items.push({
        label: t('ctxMenu.copyAbsolutePath'),
        action: () => copy(absPath)
      });
      items.push({
        label: t('ctxMenu.copyRelativePath'),
        action: () => copy(relPath || node.name),
        disabled: relPath === ''
      });
      items.push({
        label: t('ctxMenu.copyFileName'),
        action: () => copy(node.name),
        divider: true
      });
      items.push({
        label: t('ctxMenu.revealInFolder'),
        action: () => {
          void api.app.revealInFileManager(absPath).then((res) => {
            if (!res.ok) {
              showToast(t('toast.revealFailed'), { tone: 'error' });
            }
          });
        }
      });
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [
      beginCreate,
      beginRename,
      handleCutCopy,
      handleDelete,
      handleDuplicate,
      handlePaste,
      showToast,
      t
    ]
  );

  /** ルートディレクトリ右クリックメニュー。ワークスペースから外す + 新規ファイル/フォルダ + paste。 */
  const handleRootContextMenu = useCallback(
    (e: React.MouseEvent, rootPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      const cb = getClipboard();
      const items: ContextMenuItem[] = [
        {
          label: t('ctxMenu.newFile'),
          action: () => beginCreate(rootPath, '', 'file')
        },
        {
          label: t('ctxMenu.newFolder'),
          action: () => beginCreate(rootPath, '', 'folder'),
          divider: true
        },
        {
          label: t('ctxMenu.paste'),
          action: () => void handlePaste(rootPath, ''),
          disabled: !cb || cb.rootPath !== rootPath,
          divider: true
        },
        {
          label: t('workspace.remove'),
          action: () => onRemoveWorkspaceFolder(rootPath)
        }
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [beginCreate, handlePaste, onRemoveWorkspaceFolder, t]
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
    // Issue #592: 当該ディレクトリ直下に inline-input が出る場合は、entries 一覧の頭で表示する。
    const showInline =
      inlineInput &&
      inlineInput.rootPath === rootPath &&
      inlineInput.parentRel === relPath &&
      (inlineInput.mode === 'create-file' || inlineInput.mode === 'create-folder');
    if (state.entries.length === 0 && !showInline) {
      return (
        <div className="filetree__empty" style={{ paddingLeft: 10 + depth * 12 }}>
          —
        </div>
      );
    }
    return (
      <>
        {showInline && (
          <FileTreeInlineRow
            depth={depth + 1}
            kind={inlineInput.mode === 'create-folder' ? 'folder' : 'file'}
            placeholder={t(
              inlineInput.mode === 'create-folder'
                ? 'filetree.prompt.newFolderName'
                : 'filetree.prompt.newFileName'
            )}
            initialValue=""
            onSubmit={(val) => void submitInlineInput(val)}
            onCancel={() => setInlineInput(null)}
          />
        )}
        {state.entries.map((node) => {
          const childKey = dirKey(rootPath, node.path);
          const isOpen = node.isDir && expanded.has(childKey);
          const childState: DirState | null = node.isDir
            ? dirs.get(childKey) ?? null
            : null;
          const isActive = !node.isDir && activeFilePath === node.path;
          const recentRank = node.isDir
            ? -1
            : recentRankMap.get(`${rootPath}${KEY_SEP}${node.path}`) ?? -1;
          // Issue #592: rename inline-input は対象 entry を inline 入力欄で置換する。
          const isRenaming =
            inlineInput &&
            inlineInput.mode === 'rename' &&
            inlineInput.rootPath === rootPath &&
            inlineInput.originalRelPath === node.path;
          if (isRenaming) {
            return (
              <FileTreeInlineRow
                key={`rename-${childKey}`}
                depth={depth + 1}
                kind={node.isDir ? 'folder' : 'file'}
                placeholder={t('filetree.prompt.renameTo')}
                initialValue={node.name}
                onSubmit={(val) => void submitInlineInput(val)}
                onCancel={() => setInlineInput(null)}
              />
            );
          }
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
          onClick={() => beginCreate(primaryRoot, '', 'file')}
          title={t('ctxMenu.newFile')}
          aria-label={t('ctxMenu.newFile')}
          disabled={!primaryRoot}
        >
          <FilePlus size={12} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="filetree__refresh"
          onClick={() => beginCreate(primaryRoot, '', 'folder')}
          title={t('ctxMenu.newFolder')}
          aria-label={t('ctxMenu.newFolder')}
          disabled={!primaryRoot}
        >
          <FolderPlus size={12} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="filetree__refresh"
          onClick={onAddWorkspaceFolder}
          title={t('workspace.add')}
          aria-label={t('workspace.add')}
        >
          <FolderPlus size={12} strokeWidth={1.75} style={{ opacity: 0.65 }} />
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

/**
 * Issue #592: ファイルツリーのインライン入力行 (新規ファイル / 新規フォルダ / リネーム)。
 * Enter で確定 / Esc でキャンセル。blur でも確定する (VS Code と同じ挙動)。
 */
interface FileTreeInlineRowProps {
  depth: number;
  kind: 'file' | 'folder';
  placeholder: string;
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function FileTreeInlineRow({
  depth,
  kind,
  placeholder,
  initialValue,
  onSubmit,
  onCancel
}: FileTreeInlineRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  const [value, setValue] = useState(initialValue);

  // Mount 直後に input にフォーカスし、リネーム時は拡張子を除いた stem 部分を選択する。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (initialValue) {
      const dotIdx = initialValue.lastIndexOf('.');
      if (dotIdx > 0) {
        el.setSelectionRange(0, dotIdx);
      } else {
        el.select();
      }
    }
  }, [initialValue]);

  const submit = (): void => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(value);
  };

  const cancel = (): void => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onCancel();
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

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
    <div className="filetree__row filetree__inline-input" style={guideStyle}>
      {kind === 'folder' ? (
        <>
          <ChevronRight
            size={13}
            strokeWidth={2.25}
            className="filetree__chevron"
            aria-hidden
          />
          <FolderPlus
            size={14}
            strokeWidth={2}
            className="filetree__icon"
            aria-hidden
          />
        </>
      ) : (
        <>
          <span className="filetree__chevron-spacer" />
          <FilePlus
            size={14}
            strokeWidth={2}
            className="filetree__file-icon"
            aria-hidden
          />
        </>
      )}
      <input
        ref={inputRef}
        type="text"
        className="filetree__inline-input-field"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        onBlur={submit}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
      />
    </div>
  );
}
