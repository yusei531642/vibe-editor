import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  GitDiffResult,
  GitFileChange,
  GitStatus
} from '../../../../types/shared';
import { useT } from '../i18n';

export interface DiffTab {
  id: string;
  relPath: string;
  result: GitDiffResult | null;
  loading: boolean;
  pinned: boolean;
}

export interface EditorTab {
  id: string;
  /**
   * Issue #4: 開いているファイルがどのワークスペースルート配下かを記憶する。
   * 同名の相対パスが別ルートに存在し得るので、read/write や ID 衝突回避に必須。
   */
  rootPath: string;
  relPath: string;
  content: string;
  originalContent: string;
  isBinary: boolean;
  /**
   * Issue #35: 非 UTF-8 (CP932 など) を from_utf8_lossy で読んだ場合に true。
   * 編集は許可しない (保存すると lossy 変換後の UTF-8 で上書きされ、元 encoding を失うため)。
   */
  lossyEncoding: boolean;
  /**
   * Issue #102: read 時に検出した encoding。save 時にこの encoding で再エンコードして
   * 書き戻すことで UTF-16/UTF-32/UTF-8 BOM が UTF-8 にロスして変換されるのを防ぐ。
   */
  encoding: string;
  /** Issue #65: 開いた時点の mtime (ms since epoch)。save 時の external-change 検出に使う */
  mtimeMs?: number;
  /** Issue #104: 開いた時点の size。mtime 解像度の粗い FS 用に併用して検出する */
  sizeBytes?: number;
  /** Issue #119: 開いた時点の SHA-256 (hex)。同サイズ・1 秒以内の外部変更を検出するのに使う */
  contentHash?: string;
  loading: boolean;
  error: string | null;
  pinned: boolean;
}

type ToastFn = (
  msg: string,
  opts?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => void;

export interface UseFileTabsOptions {
  /** 現在のプロジェクトルート (use-project-loader が返す値をそのまま渡す)。 */
  projectRoot: string;
  /** save 後の git status 再取得。use-project-loader が返す関数をそのまま渡す。 */
  refreshGit: () => Promise<void>;
  /** rename 解決のために HEAD 側 path を引くのに使う (refreshDiffTabsForPath 内)。 */
  gitStatus: GitStatus | null;
  /** トースト通知 (App.tsx の useToast から取得した showToast を渡す)。 */
  showToast: ToastFn;
}

/**
 * Issue #480: 最近開いたファイルの履歴エントリ。
 * キーは `rootPath + KEY_SEP + relPath` で一意に識別する。
 */
export interface RecentFileEntry {
  rootPath: string;
  relPath: string;
}

/** Issue #480: 履歴上限 */
export const RECENT_FILES_LIMIT = 15;

export interface UseFileTabsResult {
  // ---- state ----
  editorTabs: EditorTab[];
  setEditorTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  diffTabs: DiffTab[];
  setDiffTabs: React.Dispatch<React.SetStateAction<DiffTab[]>>;
  recentlyClosed: DiffTab[];
  activeTabId: string | null;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;

  // ---- 派生値 ----
  dirtyEditorTabs: EditorTab[];
  /** tabIds 省略時は全 dirty を対象。confirm dialog を出して bool を返す。 */
  confirmDiscardEditorTabs: (tabIds?: string[]) => boolean;
  /**
   * Issue #480: 最近開いたファイルの履歴 (新しい順)。
   * active ファイルも含むが、UI 側で active を優先表示する。
   */
  recentFiles: RecentFileEntry[];

  // ---- handlers ----
  openEditorTab: (rootPath: string, relPath: string) => Promise<void>;
  updateEditorContent: (id: string, content: string) => void;
  saveEditorTab: (id: string) => Promise<void>;
  openDiffTab: (file: GitFileChange) => Promise<void>;
  refreshDiffTabsForPath: (relPath: string) => Promise<void>;
  closeTab: (id: string) => void;
  togglePin: (id: string) => void;
  reopenLastClosed: () => void;
  cycleTab: (direction: 1 | -1) => void;

  // ---- project switch lifecycle ----
  /**
   * use-project-loader の onProjectSwitched から呼ぶ。
   * editor / diff / recentlyClosed / activeTabId のみリセットする。
   * sessions / teams / terminal は親 (App.tsx) が引き続き責務を持つ。
   */
  resetForProjectSwitch: () => void;
}

/**
 * Issue #373 Phase 1-2: editor tab / diff tab / recentlyClosed の state と
 * それに付随する handler を App.tsx から切り出した hook。
 *
 * - opts は `optsRef.current = opts` で毎 render 更新し、内部 useCallback の deps から外す
 *   (use-project-loader.ts と同じ流儀, TDZ 回避と再生成最小化)
 * - useT は内部で直接呼ぶ (settings-context.tsx の流儀)
 * - editor/diff の DnD は **存在しない** (現状 DnD は terminal タブ専用) ため、
 *   この hook では DnD を扱わない。
 */
export function useFileTabs(opts: UseFileTabsOptions): UseFileTabsResult {
  const t = useT();

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // tabs: diff タブと editor タブを並立させ、id プレフィックスで判別する
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([]);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [recentlyClosed, setRecentlyClosed] = useState<DiffTab[]>([]);
  // Issue #480: 最近開いたファイルの履歴 (新しい順、上限 RECENT_FILES_LIMIT)
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);

  const dirtyEditorTabs = useMemo(
    () => editorTabs.filter((tab) => !tab.isBinary && tab.content !== tab.originalContent),
    [editorTabs]
  );

  const confirmDiscardEditorTabs = useCallback(
    (tabIds?: string[]): boolean => {
      const targets =
        tabIds && tabIds.length > 0
          ? dirtyEditorTabs.filter((tab) => tabIds.includes(tab.id))
          : dirtyEditorTabs;
      if (targets.length === 0) return true;
      if (targets.length === 1) {
        return window.confirm(t('editor.discardSingle', { path: targets[0].relPath }));
      }
      return window.confirm(t('editor.discardMultiple', { count: targets.length }));
    },
    [dirtyEditorTabs, t]
  );

  const openDiffTab = useCallback(
    async (file: GitFileChange) => {
      const projectRoot = optsRef.current.projectRoot;
      if (!projectRoot) return;
      const id = `diff:${file.path}`;
      setActiveTabId(id);
      setDiffTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          { id, relPath: file.path, result: null, loading: true, pinned: false }
        ];
      });
      try {
        // Issue #19: rename の場合は HEAD 側を originalPath から引く
        const result = await window.api.git.diff(projectRoot, file.path, file.originalPath);
        setDiffTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, result, loading: false } : t))
        );
      } catch (err) {
        setDiffTabs((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  loading: false,
                  result: {
                    ok: false,
                    error: String(err),
                    path: file.path,
                    isNew: false,
                    isDeleted: false,
                    isBinary: false,
                    original: '',
                    modified: ''
                  }
                }
              : t
          )
        );
      }
    },
    []
  );

  const refreshDiffTabsForPath = useCallback(
    async (relPath: string) => {
      const { projectRoot, gitStatus } = optsRef.current;
      if (!projectRoot) return;
      if (!diffTabs.some((tab) => tab.relPath === relPath)) return;
      // Issue #19: rename entry なら HEAD 側を引くため originalPath を同時に渡す
      const originalPath = gitStatus?.files.find((f) => f.path === relPath)?.originalPath;
      try {
        const result = await window.api.git.diff(projectRoot, relPath, originalPath);
        setDiffTabs((prev) =>
          prev.map((tab) =>
            tab.relPath === relPath ? { ...tab, result, loading: false } : tab
          )
        );
      } catch (err) {
        setDiffTabs((prev) =>
          prev.map((tab) =>
            tab.relPath === relPath
              ? {
                  ...tab,
                  loading: false,
                  result: {
                    ok: false,
                    error: String(err),
                    path: relPath,
                    isNew: false,
                    isDeleted: false,
                    isBinary: false,
                    original: '',
                    modified: ''
                  }
                }
              : tab
          )
        );
      }
    },
    [diffTabs]
  );

  const openEditorTab = useCallback(
    async (rootPath: string, relPath: string) => {
      const { projectRoot, showToast } = optsRef.current;
      const effectiveRoot = rootPath || projectRoot;
      if (!effectiveRoot) return;
      // Issue #4: 同じ相対パスが別ルートに存在しうるので id に root も混ぜる
      const id = `edit:${effectiveRoot}\u0001${relPath}`;
      setActiveTabId(id);
      // Issue #480: 最近開いたファイル履歴を更新 (先頭へ移動、上限制限)
      setRecentFiles((prev) => {
        const filtered = prev.filter(
          (entry) => !(entry.rootPath === effectiveRoot && entry.relPath === relPath)
        );
        return [{ rootPath: effectiveRoot, relPath }, ...filtered].slice(0, RECENT_FILES_LIMIT);
      });
      setEditorTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          {
            id,
            rootPath: effectiveRoot,
            relPath,
            content: '',
            originalContent: '',
            isBinary: false,
            lossyEncoding: false,
            encoding: 'utf-8',
            loading: true,
            error: null,
            pinned: false
          }
        ];
      });
      try {
        const res = await window.api.files.read(effectiveRoot, relPath);
        const lossy = res.encoding === 'lossy';
        // Issue #35: lossy 読み込み時はユーザーに明示的に通知する
        if (lossy) {
          showToast(
            t('editor.nonUtf8Warning', { path: relPath }),
            { tone: 'warning' }
          );
        }
        setEditorTabs((prev) =>
          prev.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  loading: false,
                  error: res.ok ? null : res.error ?? 'error',
                  content: res.content,
                  originalContent: res.content,
                  isBinary: res.isBinary,
                  lossyEncoding: lossy,
                  encoding: res.encoding || 'utf-8',
                  mtimeMs: res.mtimeMs,
                  sizeBytes: res.sizeBytes,
                  contentHash: res.contentHash
                }
              : tab
          )
        );
      } catch (err) {
        setEditorTabs((prev) =>
          prev.map((tab) =>
            tab.id === id ? { ...tab, loading: false, error: String(err) } : tab
          )
        );
      }
    },
    [t]
  );

  const updateEditorContent = useCallback((id: string, content: string) => {
    setEditorTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, content } : t))
    );
  }, []);

  const saveEditorTab = useCallback(
    async (id: string) => {
      const { projectRoot, showToast, refreshGit } = optsRef.current;
      const tab = editorTabs.find((t) => t.id === id);
      if (!tab) return;
      const targetRoot = tab.rootPath || projectRoot;
      if (!targetRoot) return;
      if (tab.isBinary) return;
      // Issue #35: lossy で読み込んだ (非 UTF-8) タブは UTF-8 書き戻すと元 encoding を失う。
      // 保存を拒否し、ユーザーに明示する。
      if (tab.lossyEncoding) {
        showToast(t('editor.nonUtf8SaveBlocked', { path: tab.relPath }), { tone: 'warning' });
        return;
      }
      if (tab.content === tab.originalContent) return;
      try {
        // Issue #65 / #104 / #102 / #119: mtime + size + encoding + content_hash を渡して、
        // 同サイズかつ秒精度では見落とされる可能性がある外部変更も内容ハッシュで検出する。
        let res = await window.api.files.write(
          targetRoot,
          tab.relPath,
          tab.content,
          tab.mtimeMs,
          tab.sizeBytes,
          tab.encoding,
          tab.contentHash
        );
        if (res.conflict) {
          // ユーザーに確認 → OK なら再度 mtime/size/hash チェックなしで書き込む
          const overwrite = window.confirm(
            t('editor.externalChangeConfirm', { path: tab.relPath })
          );
          if (!overwrite) {
            showToast(t('editor.saveAborted', { path: tab.relPath }), { tone: 'warning' });
            return;
          }
          res = await window.api.files.write(
            targetRoot,
            tab.relPath,
            tab.content,
            undefined,
            undefined,
            tab.encoding,
            undefined
          );
        }
        if (res.ok) {
          setEditorTabs((prev) =>
            prev.map((t) =>
              t.id === id
                ? {
                    ...t,
                    originalContent: t.content,
                    mtimeMs: res.mtimeMs,
                    sizeBytes: res.sizeBytes,
                    contentHash: res.contentHash
                  }
                : t
            )
          );
          showToast(t('editor.saved', { path: tab.relPath }), { tone: 'success' });
          void refreshGit();
          void refreshDiffTabsForPath(tab.relPath);
        } else {
          showToast(t('editor.saveFailed', { error: res.error ?? 'error' }), {
            tone: 'error'
          });
        }
      } catch (err) {
        showToast(t('editor.saveFailed', { error: String(err) }), { tone: 'error' });
      }
    },
    [editorTabs, refreshDiffTabsForPath, t]
  );

  const closeTab = useCallback(
    (id: string) => {
      if (id.startsWith('edit:')) {
        setEditorTabs((prev) => {
          const target = prev.find((t) => t.id === id);
          if (!target || target.pinned) return prev;
          if (
            !target.isBinary &&
            target.content !== target.originalContent &&
            !confirmDiscardEditorTabs([id])
          ) {
            return prev;
          }
          const next = prev.filter((t) => t.id !== id);
          if (activeTabId === id) {
            // 残ったエディタ or 差分タブのうち末尾を選択
            const fallback =
              next.length > 0 ? next[next.length - 1].id : diffTabs[diffTabs.length - 1]?.id ?? null;
            setActiveTabId(fallback);
          }
          return next;
        });
        return;
      }
      setDiffTabs((prev) => {
        const target = prev.find((t) => t.id === id);
        if (!target || target.pinned) return prev;
        setRecentlyClosed((rc) =>
          [target, ...rc.filter((r) => r.id !== id)].slice(0, 10)
        );
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          const fallback =
            next.length > 0 ? next[next.length - 1].id : editorTabs[editorTabs.length - 1]?.id ?? null;
          setActiveTabId(fallback);
        }
        return next;
      });
    },
    [activeTabId, confirmDiscardEditorTabs, diffTabs, editorTabs]
  );

  const togglePin = useCallback((id: string) => {
    if (id.startsWith('edit:')) {
      setEditorTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
      );
      return;
    }
    setDiffTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
    );
  }, []);

  const reopenLastClosed = useCallback(() => {
    setRecentlyClosed((rc) => {
      if (rc.length === 0) return rc;
      const [first, ...rest] = rc;
      setDiffTabs((prev) => [...prev, { ...first }]);
      setActiveTabId(first.id);
      return rest;
    });
  }, []);

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      const allIds = [
        ...diffTabs.map((t) => t.id),
        ...editorTabs.map((t) => t.id)
      ];
      if (allIds.length === 0) return;
      const idx = activeTabId ? allIds.indexOf(activeTabId) : -1;
      const next = ((idx < 0 ? 0 : idx) + direction + allIds.length) % allIds.length;
      setActiveTabId(allIds[next]);
    },
    [activeTabId, diffTabs, editorTabs]
  );

  const resetForProjectSwitch = useCallback(() => {
    setDiffTabs([]);
    setEditorTabs([]);
    setRecentlyClosed([]);
    setActiveTabId(null);
    setRecentFiles([]);
  }, []);

  return {
    editorTabs,
    setEditorTabs,
    diffTabs,
    setDiffTabs,
    recentlyClosed,
    activeTabId,
    setActiveTabId,
    dirtyEditorTabs,
    confirmDiscardEditorTabs,
    recentFiles,
    openEditorTab,
    updateEditorContent,
    saveEditorTab,
    openDiffTab,
    refreshDiffTabsForPath,
    closeTab,
    togglePin,
    reopenLastClosed,
    cycleTab,
    resetForProjectSwitch
  };
}
