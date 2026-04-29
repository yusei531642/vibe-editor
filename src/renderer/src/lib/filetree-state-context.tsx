/**
 * FileTreeStateContext — ファイルツリーの展開/折り畳み状態とディレクトリキャッシュを
 * アプリ全体で共有する Provider。
 *
 * Issue #273 で指摘された次の 4 件への対応:
 *   1. Sidebar と Canvas (FileTreeCard) の同時 mount で `update({ fileTreeExpanded })` が
 *      お互いの古い state で last-writer-wins 上書きする問題 → 共有 Context にして単一参照に。
 *   2. setState updater 内で `onPersistState` を呼んでいた副作用混在 → effect で expanded/
 *      collapsedRoots の変化に追従して persist する。React Strict Mode / concurrent rendering
 *      で updater が複数回実行されても副作用が二重発火しない。
 *   3. 存在しない root / orphan dir の prune 未実装 → mount 時に現在の roots に含まれない
 *      entry を expanded から除去。`loadDir` 失敗時にもそのキーを expanded から除去 (lazy)。
 *   4. 復元時の I/O storm → `loadDir` を最大 4 並列の queue で発火し、CLI の files.list が
 *      同時多発するのを防ぐ。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { FileNode } from '../../../types/shared';
import { useSettings } from './settings-context';

const KEY_SEP = '\0';

/** (rootPath, relPath) を一意キーに変換する。Map のキーにする。 */
export const dirKey = (rootPath: string, relPath: string): string =>
  `${rootPath}${KEY_SEP}${relPath}`;

export interface DirState {
  loading: boolean;
  error: string | null;
  entries: FileNode[];
}

export interface FileTreeStateValue {
  /** 現在の展開済みディレクトリ集合 (NUL 区切りキー) */
  expanded: Set<string>;
  /** 折り畳み済みのルート (絶対パス) 集合 */
  collapsedRoots: Set<string>;
  /** ルート配下を含むすべてのディレクトリのキャッシュ */
  dirs: Map<string, DirState>;
  /** ディレクトリ展開状態のトグル。`isDir=false` のときは no-op (FileNode を直接渡す側でガード) */
  toggleDir: (rootPath: string, relPath: string) => void;
  /** ルート (workspace folder) の折り畳み状態のトグル */
  toggleRoot: (rootPath: string) => void;
  /** files.list を発火してキャッシュを更新する。並列数は内部 queue で制限 */
  loadDir: (rootPath: string, relPath: string) => Promise<void>;
  /** 与えられた roots について、直下と展開済み配下を再ロードする */
  refreshAll: (roots: string[]) => void;
  /**
   * 現在 mount されている FileTreePanel の roots を Provider に伝えて、
   * 不要 entry を prune する trigger にする。Sidebar と FileTreeCard の双方が
   * 自分の roots を渡し、Provider は和集合に対して prune する。
   */
  registerRoots: (instanceId: string, roots: string[]) => void;
  /** unmount 時に呼ぶ。当該 instance の roots を解除する */
  unregisterRoots: (instanceId: string) => void;
}

const FileTreeStateContext = createContext<FileTreeStateValue | null>(null);

/** files.list を同時に何本までに絞るか (Issue #273 #4: I/O storm 対策)。 */
const MAX_CONCURRENT_LOADS = 4;

interface QueuedLoad {
  key: string;
  run: () => Promise<void>;
}

export function FileTreeStateProvider({ children }: { children: ReactNode }): JSX.Element {
  const { settings, update } = useSettings();

  // 初期値は settings からの復元。lazy 初期化で mount 時の値だけ採用 (以後は内部 state 単独管理)。
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set<string>();
    const map = settings.fileTreeExpanded ?? {};
    for (const [root, rels] of Object.entries(map)) {
      if (typeof root !== 'string' || !root) continue;
      if (!Array.isArray(rels)) continue;
      for (const rel of rels) {
        if (typeof rel !== 'string') continue;
        set.add(dirKey(root, rel));
      }
    }
    return set;
  });
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(
    () => new Set(settings.fileTreeCollapsedRoots ?? [])
  );
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());

  // mount 中の FileTreePanel ごとの roots を集約して prune に使う。
  const [activeRootsByInstance, setActiveRootsByInstance] = useState<Map<string, string[]>>(
    new Map()
  );

  // updater 内副作用の代わりに effect で persist する (Issue #273 #2)。
  // settings-context 内で 200ms debounce + atomic_write が走るので、ここでは debounce 不要。
  // 初期復元で expanded が変わっても update が呼ばれるが、settings との等価性比較は context 側。
  useEffect(() => {
    const map: Record<string, string[]> = {};
    for (const key of expanded) {
      const sep = key.indexOf(KEY_SEP);
      if (sep <= 0) continue;
      const root = key.slice(0, sep);
      const rel = key.slice(sep + 1);
      (map[root] ??= []).push(rel);
    }
    void update({
      fileTreeExpanded: map,
      fileTreeCollapsedRoots: Array.from(collapsedRoots)
    });
  }, [expanded, collapsedRoots, update]);

  // I/O キュー: 並列度を MAX_CONCURRENT_LOADS に制限する。
  // queue は ref で持つ (state にすると各 enqueue が re-render を誘発する)。
  // pendingKeys で重複 enqueue を防ぐ (同 key を 2 回 loadDir しても無駄)。
  const queueRef = useRef<QueuedLoad[]>([]);
  const activeRef = useRef(0);
  const pendingKeysRef = useRef<Set<string>>(new Set());

  const drainQueue = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT_LOADS && queueRef.current.length > 0) {
      const item = queueRef.current.shift();
      if (!item) break;
      activeRef.current += 1;
      void item
        .run()
        .finally(() => {
          pendingKeysRef.current.delete(item.key);
          activeRef.current -= 1;
          drainQueue();
        });
    }
  }, []);

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
      // 既に同 key が queue に入っているか実行中なら enqueue しない (重複 IPC 抑制)。
      if (pendingKeysRef.current.has(key)) return;
      pendingKeysRef.current.add(key);

      return new Promise<void>((resolve) => {
        queueRef.current.push({
          key,
          run: async () => {
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
              // Issue #273 #3 (lazy prune): list 失敗 = orphan dir 候補。expanded から除去。
              if (!res.ok) {
                setExpanded((prev) => {
                  if (!prev.has(key)) return prev;
                  const next = new Set(prev);
                  next.delete(key);
                  return next;
                });
              }
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
              // catch 経路でも prune する (rootPath が無効な絶対パス等)。
              setExpanded((prev) => {
                if (!prev.has(key)) return prev;
                const next = new Set(prev);
                next.delete(key);
                return next;
              });
            } finally {
              resolve();
            }
          }
        });
        drainQueue();
      });
    },
    [drainQueue]
  );

  const toggleDir = useCallback(
    (rootPath: string, relPath: string) => {
      const key = dirKey(rootPath, relPath);
      // setState updater 内では副作用を呼ばず、純粋に state を更新する (Issue #273 #2)。
      // 永続化は上の useEffect が expanded の変化を観測して 1 度だけ走る。
      setExpanded((prev) => {
        const next = new Set(prev);
        const wasOpen = next.has(key);
        if (wasOpen) next.delete(key);
        else next.add(key);
        return next;
      });
      // expanded が新規追加された (= wasOpen が false → 新たに展開) ときだけ loadDir。
      // setState の prev を読まないと wasOpen を判定できないので、ここでは expanded から
      // 直接読む (closure の expanded は前回 render の値だが、判定は「未キャッシュなら load」
      // に倒すので問題ない)。
      const isAlreadyCached = dirs.has(key);
      const wasOpen = expanded.has(key);
      if (!wasOpen && !isAlreadyCached) {
        void loadDir(rootPath, relPath);
      }
    },
    [expanded, dirs, loadDir]
  );

  const toggleRoot = useCallback((rootPath: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  }, []);

  const refreshAll = useCallback(
    (roots: string[]) => {
      for (const root of roots) {
        void loadDir(root, '');
      }
      for (const key of expanded) {
        const sep = key.indexOf(KEY_SEP);
        if (sep <= 0) continue;
        const rootPath = key.slice(0, sep);
        const relPath = key.slice(sep + 1);
        if (rootPath && roots.includes(rootPath)) {
          void loadDir(rootPath, relPath);
        }
      }
    },
    [expanded, loadDir]
  );

  const registerRoots = useCallback((instanceId: string, roots: string[]) => {
    setActiveRootsByInstance((prev) => {
      const existing = prev.get(instanceId);
      // identity 比較で同じなら更新しない (再 render 抑制)。
      if (
        existing &&
        existing.length === roots.length &&
        existing.every((r, i) => r === roots[i])
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(instanceId, roots);
      return next;
    });
  }, []);

  const unregisterRoots = useCallback((instanceId: string) => {
    setActiveRootsByInstance((prev) => {
      if (!prev.has(instanceId)) return prev;
      const next = new Map(prev);
      next.delete(instanceId);
      return next;
    });
  }, []);

  // Issue #273 #3: prune. 全 instance の roots 和集合に含まれない entry を expanded から除去。
  // どの instance も mount されていない (= ファイルツリー UI 非表示) ときは prune しない
  // (起動初期で root が無いまま expanded を空にしてしまうのを避ける)。
  useEffect(() => {
    if (activeRootsByInstance.size === 0) return;
    const allRoots = new Set<string>();
    for (const list of activeRootsByInstance.values()) {
      for (const r of list) {
        if (r) allRoots.add(r);
      }
    }
    if (allRoots.size === 0) return;

    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of prev) {
        const sep = key.indexOf(KEY_SEP);
        if (sep <= 0) {
          next.delete(key);
          changed = true;
          continue;
        }
        const root = key.slice(0, sep);
        if (!allRoots.has(root)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    setCollapsedRoots((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const root of prev) {
        if (!allRoots.has(root)) {
          next.delete(root);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeRootsByInstance]);

  const value = useMemo<FileTreeStateValue>(
    () => ({
      expanded,
      collapsedRoots,
      dirs,
      toggleDir,
      toggleRoot,
      loadDir,
      refreshAll,
      registerRoots,
      unregisterRoots
    }),
    [
      expanded,
      collapsedRoots,
      dirs,
      toggleDir,
      toggleRoot,
      loadDir,
      refreshAll,
      registerRoots,
      unregisterRoots
    ]
  );

  return (
    <FileTreeStateContext.Provider value={value}>{children}</FileTreeStateContext.Provider>
  );
}

export function useFileTreeState(): FileTreeStateValue {
  const ctx = useContext(FileTreeStateContext);
  if (!ctx) {
    throw new Error(
      'useFileTreeState は FileTreeStateProvider の子孫で呼び出してください'
    );
  }
  return ctx;
}
