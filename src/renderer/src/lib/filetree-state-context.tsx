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
 *   3. 存在しない root / orphan dir の prune 未実装 → settings.workspaceFolders と
 *      lastOpenedRoot を canonical な root truth として参照、これに含まれない expanded
 *      entry を prune。`loadDir` 失敗時にもそのキーを expanded から prune (lazy)。
 *   4. 復元時の I/O storm → `loadDir` を最大 4 並列の queue で発火し、CLI の files.list が
 *      同時多発するのを防ぐ。pending Promise Map で重複呼び出しを統一 Promise 化。
 *
 * 自己レビュー (Codex 不在の代替) で発覚した critical 問題への対応:
 *   - 初期 mount 直後の persist が settings 未ロードの空値で過去保存値を上書きする問題
 *     → useSettingsLoading + hydratedRef で hydrate 完了まで persist 抑止。
 *   - useSettings 全購読で他 settings の変化が Provider re-render を誘発する問題
 *     → useSettingsValue / useSettingsActions の細粒度 selector に置換。
 *   - toggleDir の closure stale な wasOpen 判定 → setExpanded updater 内で nowOpened 捕捉。
 *   - Canvas FileTreeCard が limited extraRoots を持つと sidebar の expanded が prune される
 *     問題 → registerRoots ではなく settings の workspace truth で prune する。
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
import {
  useSettingsActions,
  useSettingsLoading,
  useSettingsValue
} from './settings-context';

const KEY_SEP_CHAR = '\0';

/** `(rootPath, relPath)` を区切る NUL 文字。パス内に出現しないので衝突しない。
 *  外部 (FileTreePanel 等) でもこの定数を使い、定義の重複を避ける。 */
export const KEY_SEP = KEY_SEP_CHAR;

/** (rootPath, relPath) を一意キーに変換する。 */
export const dirKey = (rootPath: string, relPath: string): string =>
  `${rootPath}${KEY_SEP}${relPath}`;

/** dirKey を分解する。不正な key (sep 無し / 空 root) は null。 */
export function splitKey(key: string): { rootPath: string; relPath: string } | null {
  const sep = key.indexOf(KEY_SEP);
  if (sep <= 0) return null;
  return { rootPath: key.slice(0, sep), relPath: key.slice(sep + 1) };
}

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
   * 現在 mount されている FileTreePanel の roots を Provider に伝える。
   * 補助情報 (Sidebar / Canvas のどこで FileTreePanel が描画されているか) として記録するが、
   * prune の真理値は `settings.workspaceFolders + lastOpenedRoot` であり、ここの登録だけで
   * は expanded を prune しない (Canvas の payload で limited extraRoots が来ると sidebar
   * の保存値を消してしまうため)。
   */
  registerRoots: (instanceId: string, roots: string[]) => void;
  /** unmount 時に呼ぶ。当該 instance の roots を解除する */
  unregisterRoots: (instanceId: string) => void;
}

const FileTreeStateContext = createContext<FileTreeStateValue | null>(null);

/** files.list を同時に何本までに絞るか (Issue #273 #4: I/O storm 対策)。
 *  4 は SSD / 一般的な user machine で「逐次キューよりは並列度を取りつつ、
 *  HDD のシーク負荷で詰まらない」中庸値。設定化は別 issue 候補。 */
const MAX_CONCURRENT_LOADS = 4;

interface QueuedLoad {
  key: string;
  run: () => Promise<void>;
}

/** settings.fileTreeExpanded (Record<root, rels[]>) を NUL 区切り Set に展開する。 */
function deserializeExpanded(map: Record<string, string[]> | undefined): Set<string> {
  const set = new Set<string>();
  if (!map) return set;
  for (const [root, rels] of Object.entries(map)) {
    if (typeof root !== 'string' || !root) continue;
    if (!Array.isArray(rels)) continue;
    for (const rel of rels) {
      if (typeof rel !== 'string') continue;
      set.add(dirKey(root, rel));
    }
  }
  return set;
}

/** Set<key> を settings 保存形式 (Record<root, rels[]>) にシリアライズする。 */
function serializeExpanded(set: Set<string>): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const key of set) {
    const split = splitKey(key);
    if (!split) continue;
    (map[split.rootPath] ??= []).push(split.relPath);
  }
  return map;
}

export function FileTreeStateProvider({ children }: { children: ReactNode }): JSX.Element {
  // settings の他フィールド (テーマ / フォント等) の変化で Provider が re-render しない
  // ように、必要なフィールドだけ細粒度 selector で購読する。
  const settingsLoading = useSettingsLoading();
  const persistedExpanded = useSettingsValue('fileTreeExpanded');
  const persistedCollapsedRoots = useSettingsValue('fileTreeCollapsedRoots');
  const lastOpenedRoot = useSettingsValue('lastOpenedRoot');
  const claudeCwd = useSettingsValue('claudeCwd');
  const workspaceFolders = useSettingsValue('workspaceFolders');
  const { update } = useSettingsActions();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());

  // Issue #273 自己レビュー C1/C2: SettingsProvider は `useState(DEFAULT_SETTINGS)` で
  // 起動し、`window.api.settings.load()` を await して非同期で hydrate する。よって
  // FileTreeStateProvider の useState lazy 初期化は「settings 未ロードの空値」を採用
  // してしまう。それで persist effect が即発火するとディスク上の保存値を空で上書き
  // するので、`loading=false` になってから一度だけ state を hydrate する + hydrate 前は
  // persist を完全に skip する。
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (settingsLoading || hydratedRef.current) return;
    hydratedRef.current = true;
    setExpanded(deserializeExpanded(persistedExpanded));
    setCollapsedRoots(new Set(persistedCollapsedRoots ?? []));
  }, [settingsLoading, persistedExpanded, persistedCollapsedRoots]);

  // mount 中の FileTreePanel ごとの roots を集約 (補助情報。prune 判定には使わない)。
  const [activeRootsByInstance, setActiveRootsByInstance] = useState<Map<string, string[]>>(
    new Map()
  );

  // updater 内副作用の代わりに effect で persist する (Issue #273 #2)。
  // settings-context 内で 200ms debounce + atomic_write が走るので、ここでは debounce 不要。
  // hydrate 完了前は skip して空値による上書きを防ぐ (自己レビュー C1)。
  useEffect(() => {
    if (!hydratedRef.current) return;
    void update({
      fileTreeExpanded: serializeExpanded(expanded),
      fileTreeCollapsedRoots: Array.from(collapsedRoots)
    });
  }, [expanded, collapsedRoots, update]);

  // Issue #273 #3: prune の真理値は `settings.workspaceFolders + lastOpenedRoot/claudeCwd`。
  // 自己レビュー W1: registerRoots 経由で取った instance roots は Canvas で限定 payload
  // (例: payload.extraRoots) を持たれた場合に sidebar の保存値まで prune してしまうので、
  // prune の決定打にはしない。settings 由来の workspace truth に含まれないものだけ prune。
  const canonicalRoots = useMemo(() => {
    const set = new Set<string>();
    if (lastOpenedRoot) set.add(lastOpenedRoot);
    if (claudeCwd) set.add(claudeCwd);
    if (Array.isArray(workspaceFolders)) {
      for (const r of workspaceFolders) {
        if (typeof r === 'string' && r) set.add(r);
      }
    }
    return set;
  }, [lastOpenedRoot, claudeCwd, workspaceFolders]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (canonicalRoots.size === 0) return;

    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of prev) {
        const split = splitKey(key);
        if (!split) {
          next.delete(key);
          changed = true;
          continue;
        }
        if (!canonicalRoots.has(split.rootPath)) {
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
        if (!canonicalRoots.has(root)) {
          next.delete(root);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // dirs キャッシュも canonical に含まれない root のものは purge (memory leak 防止)。
    setDirs((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of prev.keys()) {
        const split = splitKey(key);
        if (!split) {
          next.delete(key);
          changed = true;
          continue;
        }
        if (!canonicalRoots.has(split.rootPath)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [canonicalRoots]);

  // I/O キュー: 並列度を MAX_CONCURRENT_LOADS に制限する (Issue #273 #4)。
  // queue は ref で持つ (state にすると enqueue ごとに re-render が起きる)。
  // 自己レビュー W3: pending 中の Promise を Map に保持し、同 key の重複 loadDir 呼び出し
  // でも同じ Promise を返す (semantics 統一)。
  const queueRef = useRef<QueuedLoad[]>([]);
  const activeRef = useRef(0);
  const pendingPromisesRef = useRef<Map<string, Promise<void>>>(new Map());

  const drainQueue = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT_LOADS && queueRef.current.length > 0) {
      const item = queueRef.current.shift();
      if (!item) break;
      activeRef.current += 1;
      void item
        .run()
        .finally(() => {
          pendingPromisesRef.current.delete(item.key);
          activeRef.current -= 1;
          drainQueue();
        });
    }
  }, []);

  /**
   * loadDir 失敗時に該当 key を expanded から除去する。
   * orphan dir (削除された / 移動した) を起動時の I/O storm として再試行し続けないための
   * lazy prune 戦略 (Issue #273 #3 の lazy 部分)。dirs キャッシュ側にエラー DirState は
   * 残しておくので、UI には「— (空)」相当の error 表示が出る。
   */
  const pruneOnLoadFailure = useCallback((key: string) => {
    setExpanded((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const loadDir = useCallback(
    (rootPath: string, relPath: string): Promise<void> => {
      if (!rootPath) return Promise.resolve();
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
        return Promise.resolve();
      }
      const key = dirKey(rootPath, relPath);
      const existing = pendingPromisesRef.current.get(key);
      if (existing) return existing;

      const promise = new Promise<void>((resolve) => {
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
              if (!res.ok) pruneOnLoadFailure(key);
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
              pruneOnLoadFailure(key);
            } finally {
              resolve();
            }
          }
        });
        drainQueue();
      });
      pendingPromisesRef.current.set(key, promise);
      return promise;
    },
    [drainQueue, pruneOnLoadFailure]
  );

  // 自己レビュー N1 / W1 / A3: setState updater 内で wasOpen を判定して loadDir 必要性を
  // 確定する (closure stale を排除)。dirs.has は呼び出し時 closure でも実害なし
  // (load の重複は pendingPromisesRef で抑止される)。
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  const toggleDir = useCallback(
    (rootPath: string, relPath: string) => {
      const key = dirKey(rootPath, relPath);
      let nowOpened = false;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
          nowOpened = true;
        }
        return next;
      });
      if (nowOpened && !dirsRef.current.has(key)) {
        void loadDir(rootPath, relPath);
      }
    },
    [loadDir]
  );

  const toggleRoot = useCallback((rootPath: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  }, []);

  // 自己レビュー: refreshAll 内で expanded を closure 経由で見ると stale なので、
  // ref 経由で最新値を読む。
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const refreshAll = useCallback(
    (roots: string[]) => {
      for (const root of roots) {
        void loadDir(root, '');
      }
      for (const key of expandedRef.current) {
        const split = splitKey(key);
        if (!split) continue;
        if (split.rootPath && roots.includes(split.rootPath)) {
          void loadDir(split.rootPath, split.relPath);
        }
      }
    },
    [loadDir]
  );

  const registerRoots = useCallback((instanceId: string, roots: string[]) => {
    setActiveRootsByInstance((prev) => {
      const existing = prev.get(instanceId);
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

  // activeRootsByInstance 自体は API 互換のため残すが、現状 prune には使わない
  // (canonical roots を真理値にした自己レビュー W1 への対応)。将来 UI で
  // 「現在マウント中のパネルだけ描画」等の判定に使えるよう露出だけしておく。
  void activeRootsByInstance;

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
