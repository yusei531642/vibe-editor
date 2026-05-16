import {
  useEffect,
  useId,
  useMemo,
  useState,
  useCallback
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  RefreshCw,
  X
} from 'lucide-react';
import type { FileNode } from '../../../types/shared';
import type { RecentFileEntry } from '../lib/hooks/use-file-tabs';
import { useT } from '../lib/i18n';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useToast } from '../lib/toast-context';
import { api } from '../lib/tauri-api';
import {
  KEY_SEP,
  dirKey,
  splitKey,
  useFileTreeState
} from '../lib/filetree-state-context';
import { useFileTreeClipboardStore } from '../stores/fileTreeClipboard';
import { FileTreeChildren } from './filetree/FileTreeChildren';
import type { InlineInputState } from './filetree/types';
import {
  basenameOfRel,
  joinRel,
  parentOfRel,
  shortName,
  uniqueName
} from './filetree/utils';

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
  // Issue #734: clipboard は module-level mutable state ではなく zustand 管理にする。
  // hook 購読により paste 項目の disabled 更新も React の再描画として扱える。
  const clipboard = useFileTreeClipboardStore((state) => state.clipboard);
  const setClipboard = useFileTreeClipboardStore((state) => state.setClipboard);

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

  /**
   * Issue #592: inline input の確定処理。失敗時は error toast を出して input は閉じない。
   *
   * **PR #695 review (Correctness)**: 戻り値で確定の成否を呼び出し側に通知する。
   * `true` = 入力行を閉じてよい / `false` = 失敗したので入力行を残し再入力を受け付ける。
   * これがないと、ok=false で早期 return した後に `FileTreeInlineRow.submittedRef` が
   * `true` のままになり、再度 Enter / Esc / blur しても何も動かず UI が固まる。
   */
  const submitInlineInput = useCallback(
    async (raw: string): Promise<boolean> => {
      if (!inlineInput) return true;
      const trimmed = raw.trim();
      if (!trimmed) {
        setInlineInput(null);
        return true;
      }
      const { rootPath, parentRel, mode, originalRelPath } = inlineInput;
      try {
        if (mode === 'create-file') {
          const res = await api.files.create(rootPath, parentRel, trimmed, false);
          if (!res.ok) {
            showOpError(res.error);
            return false;
          }
          showToast(t('toast.fileCreated', { name: trimmed }), { tone: 'success' });
          refreshDir(rootPath, parentRel);
          // VS Code と同じ挙動: 新規ファイルはエディタで開く
          onOpenFile(rootPath, joinRel(parentRel, trimmed));
        } else if (mode === 'create-folder') {
          const res = await api.files.createDir(rootPath, parentRel, trimmed);
          if (!res.ok) {
            showOpError(res.error);
            return false;
          }
          showToast(t('toast.folderCreated', { name: trimmed }), { tone: 'success' });
          refreshDir(rootPath, parentRel);
        } else if (mode === 'rename' && originalRelPath !== undefined) {
          if (basenameOfRel(originalRelPath) === trimmed) {
            setInlineInput(null);
            return true;
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
            return false;
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
        return true;
      } catch (e) {
        showOpError(String(e));
        return false;
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
    [setClipboard]
  );

  /** Issue #592: paste 実行。clipboard が `cut` なら files.rename (move)、
   *  `copy` なら files.copy (再帰コピー) を呼ぶ。同名衝突時は uniqueName 化。
   *  `targetParentRel` は paste 先のディレクトリ相対パス (空文字でルート)。 */
  const handlePaste = useCallback(
    async (rootPath: string, targetParentRel: string) => {
      const cb = useFileTreeClipboardStore.getState().clipboard;
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
    [dirs, refreshDir, setClipboard, showOpError, showToast, t]
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
        disabled: !clipboard || clipboard.rootPath !== rootPath
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
      clipboard,
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
          disabled: !clipboard || clipboard.rootPath !== rootPath,
          divider: true
        },
        {
          label: t('workspace.remove'),
          action: () => onRemoveWorkspaceFolder(rootPath)
        }
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [beginCreate, clipboard, handlePaste, onRemoveWorkspaceFolder, t]
  );

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
              {!collapsed && (
                <FileTreeChildren
                  rootPath={root}
                  relPath=""
                  depth={0}
                  dirs={dirs}
                  expanded={expanded}
                  activeFilePath={activeFilePath}
                  recentRankMap={recentRankMap}
                  inlineInput={inlineInput}
                  newFolderPlaceholder={t('filetree.prompt.newFolderName')}
                  newFilePlaceholder={t('filetree.prompt.newFileName')}
                  renamePlaceholder={t('filetree.prompt.renameTo')}
                  onInlineSubmit={submitInlineInput}
                  onInlineCancel={() => setInlineInput(null)}
                  onToggle={toggleDir}
                  onOpenFile={onOpenFile}
                  onContextMenu={handleContextMenu}
                />
              )}
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
