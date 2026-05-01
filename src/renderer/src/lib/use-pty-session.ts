import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalExitInfo } from '../../../types/shared';
import { computeUnscaledGrid } from './compute-unscaled-grid';
import type { CellSize } from './measure-cell-size';

export interface PtySpawnSnapshot {
  args?: string[];
  env?: Record<string, string>;
  teamId?: string;
  agentId?: string;
  role?: string;
  initialMessage?: string | string[];
  codexInstructions?: string;
}

export interface PtySessionCallbacks {
  onStatus?: (status: string) => void;
  onActivity?: () => void;
  onExit?: () => void;
  onSessionId?: (sessionId: string) => void;
  /** ユーザーの xterm 入力 (キーストローク・改行含む) を観察したいとき。
   *  画面表示や pty 書き込みは別途行うので、純粋にスニファとして使う想定。 */
  onUserInput?: (data: string) => void;
  /**
   * Issue #342 Phase 1: terminal_create の spawn 失敗時に呼ばれる。
   * `res.error` の文字列をそのまま渡す。AgentNodeCard などが本コールバックで
   * `ackRecruit({ ok: false, phase: 'spawn' | 'engine_binary_missing' })` を発火し、
   * Hub の recruit timeout (>30s) を待たず即座に構造化エラーを返せるようにする。
   * 通常タブ等 recruit に紐付かない経路では未指定で OK (no-op)。
   */
  onSpawnError?: (error: string) => void;
}

export interface UsePtySessionOptions {
  cwd: string;
  /** `cwd` が無効だったときに main 側でフォールバックに使うパス */
  fallbackCwd?: string;
  command: string;
  /**
   * Issue #271: HMR remount 時に同じ PTY へ再 bind するための論理キー。
   * 親が `term:${tab.id}` / `canvas-term:${node.id}` 等の安定した文字列を
   * 渡すと、Vite HMR で本フックが unmount → remount しても terminal.kill を
   * 飛ばさず、`import.meta.hot.data` 経由で旧 ptyId を引き継いで bind だけ
   * やり直す。値が undefined のときは従来通り unmount で kill する。
   */
  sessionKey?: string;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
  /** 初回 spawn 時にスナップショットとして読むので ref 経由 (不変式 #2) */
  snapRef: MutableRefObject<PtySpawnSnapshot>;
  /** callback は毎レンダー更新されるので ref 経由 */
  callbacksRef: MutableRefObject<PtySessionCallbacks>;
  /** pty id を受け取る ref。外から渡すことで他フックと共有する */
  ptyIdRef: MutableRefObject<string | null>;
  /** 破棄フラグを受け取る ref。外から渡すことで他フックと共有する */
  disposedRef: MutableRefObject<boolean>;
  /** onData 到着時に呼ばれる観察コールバック (auto-initial-message 用) */
  observeChunk: (data: string) => void;
  /** Canvas モード: transform: scale(zoom) 配下で論理 px ベースで初回 cols/rows を決める */
  unscaledFit?: boolean;
  /** unscaled fit 用のセルメトリクス取得 */
  getCellSize?: () => CellSize | null;
  /** unscaled fit 用のコンテナ参照 (clientWidth/clientHeight 取得) */
  containerRef?: RefObject<HTMLDivElement>;
  /**
   * useFitToContainer と共有する「最後にスケジュールしたサイズ」ref。
   * 初回 spawn 時の `term.resize(cols, rows)` 後に seed しておくと、その直後に走る
   * useFitToContainer の visible-effect refit が IPC を二重発火させずに済む。
   */
  lastScheduledRef?: MutableRefObject<{ cols: number; rows: number } | null>;
}

/**
 * Issue #271: HMR remount 判定の二段構え。
 *
 * 1. `hmrDisposeArmed` フラグ
 *    `import.meta.hot.dispose(cb)` で「HMR が今この module を捨てる」シグナルを
 *    受けたら true にする。次のタブ close / restart / card 削除 etc. のような
 *    通常 unmount 経路では `dispose` cb は呼ばれないので false のまま。
 *    フラグは「次に hook が mount された effect の冒頭」で false に戻す。
 *    これにより React Refresh の effect cleanup が遅れても、タイマーに依存せず
 *    HMR cleanup と通常 unmount を区別できる。
 *
 * 2. `import.meta.hot.data.ptyBySessionKey`
 *    HMR cleanup で kill を skip した PTY id を sessionKey ごとに保存する。
 *    次の mount で `attachIfExists: true` を載せて Rust preflight に渡し、
 *    既存 PTY に bind し直す。production では `import.meta.hot` 自体が undefined。
 */

interface HmrPtyCacheEntry {
  ptyId: string;
  generation: number;
}

/** HMR dispose 中フラグ。useEffect cleanup から見える module-scoped 状態。 */
const hmrDisposeArmed = { current: false };

// dev のみ: HMR dispose hook を 1 回だけ登録する。
// 「タイマーで戻す」のではなく、次の hook mount の effect 冒頭で戻すので、
// React Refresh の cleanup が遅れて走っても判定が壊れない。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __hot = (import.meta as any).hot as
  | {
      dispose: (cb: () => void) => void;
      data?: Record<string, unknown>;
    }
  | undefined;
if (__hot && !(__hot as { __vibePtyHookInstalled?: boolean }).__vibePtyHookInstalled) {
  (__hot as { __vibePtyHookInstalled?: boolean }).__vibePtyHookInstalled = true;
  __hot.dispose(() => {
    // この cb が呼ばれた = HMR が module を捨てる。直後に effect cleanup が
    // 全 hook で走るので、cleanup 側はこのフラグを見て kill skip を判定する。
    hmrDisposeArmed.current = true;
  });
}

/** `import.meta.hot.data.ptyBySessionKey` を sessionKey → ptyId の Map として参照する。 */
function getHmrPtyCache(): Record<string, HmrPtyCacheEntry> | null {
  // dev mode 限定。本番ビルドでは import.meta.hot が undefined なので null を返す。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hot = (import.meta as any).hot as
    | { data?: Record<string, unknown> }
    | undefined;
  if (!hot) return null;
  if (!hot.data) return null;
  if (!hot.data.ptyBySessionKey) {
    hot.data.ptyBySessionKey = {} as Record<string, HmrPtyCacheEntry>;
  }
  return hot.data.ptyBySessionKey as Record<string, HmrPtyCacheEntry>;
}

/**
 * pty の spawn / データ購読 / 終了通知 / kill を一手に引き受けるフック。
 *
 * 不変式 #1: effect deps は `[cwd, command]` のみ。
 *   他の props (args / env / initialMessage / teamId / agentId / role / sessionKey) や
 *   callbacks は ref 経由で読むので deps に入れなくてよい。
 *   これにより並び替えや親コンポーネントの再レンダーで pty が巻き添え kill されない。
 *   sessionKey は「mount identity」として扱うので、親側で同じカード/タブの間は
 *   変えない前提。変わると effect が再 run して新規 PTY 起動になる。
 *
 * 不変式 #2: 初回 spawn 時点の `args` / `env` / `initialMessage` を `snapRef` に
 *   退避してから `terminal.create` に渡す。以後 props が変化してもこの spawn には影響しない。
 */
export function usePtySession(options: UsePtySessionOptions): void {
  const {
    cwd,
    fallbackCwd,
    command,
    sessionKey,
    termRef,
    fitRef,
    snapRef,
    callbacksRef,
    ptyIdRef,
    disposedRef,
    observeChunk,
    unscaledFit = false,
    getCellSize,
    containerRef,
    lastScheduledRef
  } = options;
  // sessionKey は HMR cleanup / preflight 判定のために effect 内で参照したいので
  // ref に退避しておく (deps から外しても stale にならないため)。
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  const observeChunkRef = useRef(observeChunk);
  observeChunkRef.current = observeChunk;
  // Issue #253 sub (H2'): closure 直読 → ref 化。font 変更直後に cwd/command も
  // 切り替わって effect が re-run するレアケースで、古い getCellSize/unscaledFit を
  // 拾ってしまう stale closure リスクを排除する。
  const unscaledFitRef = useRef(unscaledFit);
  unscaledFitRef.current = unscaledFit;
  const getCellSizeRef = useRef(getCellSize);
  getCellSizeRef.current = getCellSize;
  const containerRefRef = useRef(containerRef);
  containerRefRef.current = containerRef;
  const lastScheduledRefRef = useRef(lastScheduledRef);
  lastScheduledRefRef.current = lastScheduledRef;

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;

    // Issue #271: HMR dispose フラグを mount のたびに下ろす。
    // 直前の cleanup が dispose 中のものだったとしても、新しい mount では「次の
    // unmount は通常」とみなしたいため、ここで明示的にリセットする。
    // hot.dispose の cb が再度呼ばれるまで `hmrDisposeArmed.current` は false。
    hmrDisposeArmed.current = false;

    disposedRef.current = false;
    // 注意: disposedRef は外部共有 (options.disposedRef) なので、cwd/command 変化で
    // この effect が再実行されたとき、古い effect の in-flight await が戻ってきた時点で
    // `disposedRef.current` は新 effect が line 78 で false にリセットしている。
    // よって disposedRef だけ見ると「古い spawn が終わった直後に、新セッションの id に
    // 対して古い async が listener を付ける」race が発生しうる。
    // effect-local な localDisposed を併用し、再 run でも確実に古い spawn を無効化する。
    let localDisposed = false;
    let repairFrame: number | null = null;

    const scheduleRenderRepair = (): void => {
      if (repairFrame !== null) return;
      repairFrame = window.requestAnimationFrame(() => {
        repairFrame = null;
        const liveTerm = termRef.current;
        if (!liveTerm) return;
        try {
          liveTerm.refresh(0, Math.max(0, liveTerm.rows - 1));
        } catch {
          /* dispose 直後などの refresh 失敗は無視 */
        }
      });
    };

    // 初期サイズ調整は async IIFE 内に移動 (Review #1: document.fonts.ready 待ちのため)
    let initialCols = 80;
    let initialRows = 24;

    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let offSessionId: (() => void) | null = null;

    // Issue #285: pre-subscribe / mismatch re-subscribe / cleanup / catch のどこから
    // 呼んでも安全な listener 解除関数。`?.()` で null も二重解除も safe。try ブロック
    // 内でも catch でも同じ参照を使えるよう effect スコープに置く。
    const unsubscribePtyListeners = (): void => {
      offData?.();
      offExit?.();
      offSessionId?.();
      offData = null;
      offExit = null;
      offSessionId = null;
    };

    // Issue #271: bind 世代番号。listener コールバックは「自分が登録された世代と同じ」
    // なら処理し、古い世代なら無視する。これにより HMR remount で 2 重登録された
    // 古い callback が xterm に二重出力するのを防ぐ。
    const myGeneration = (() => {
      const cache = getHmrPtyCache();
      const skey = sessionKeyRef.current;
      if (cache && skey) {
        const entry = cache[skey];
        const next = (entry?.generation ?? 0) + 1;
        cache[skey] = { ptyId: entry?.ptyId ?? '', generation: next };
        return next;
      }
      return 1;
    })();

    // sessionKey は IIFE 進行中も値を変えない (mount identity)。helper / IIFE 双方が
    // 参照するので effect 冒頭で 1 度だけ ref から退避し、以降は変数で扱う。
    const skey = sessionKeyRef.current;

    // Issue #271 と独立: HMR cache の世代比較。listener が登録された後に
    // 別 mount で世代番号が更新された場合、古い callback は no-op に倒す。
    // pre-subscribe 経路 / post-subscribe 経路の両方で参照する。
    const isCurrentGeneration = (): boolean => {
      if (!skey) return true;
      const c = getHmrPtyCache();
      if (!c) return true;
      return c[skey]?.generation === myGeneration;
    };

    // === Helper 1: loadInitialMetrics ===
    // Issue #253 review (W#1 + #3 + #4): web font (JetBrains Mono Variable 等) ロード前に
    // measureCellSize が走ると system monospace のメトリクスを返し、誤った cellW で
    // PTY が立つ。Canvas モードでは fonts.ready を待ってから測ることで、Codex の
    // banner も初回描画から正しい寸法で描画される。IDE モードでは fit.fit() が DOM
    // メトリクスベースなので待つ必要なし。
    // タイムアウト 300ms: コールドキャッシュ / 低速 I/O 環境で fonts.ready が秒オーダー
    // で resolve しないとき spawn が体感遅延する問題を回避。300ms 経過時は fallback
    // メトリクスで spawn し、後続の useFitToContainer の fonts.ready effect が ready 後
    // 1 回だけ refit を発火して補正するので、一瞬だけずれた表示も自動回復する。
    const loadInitialMetrics = async (): Promise<void> => {
      if (unscaledFitRef.current && typeof document !== 'undefined' && document.fonts) {
        let timedOut = false;
        try {
          await Promise.race([
            document.fonts.ready.then(() => undefined),
            new Promise<void>((resolve) =>
              window.setTimeout(() => {
                timedOut = true;
                resolve();
              }, 300)
            )
          ]);
        } catch {
          /* fonts.ready は通常 reject しないが、念のため握りつぶす */
        }
        if (timedOut && import.meta.env.DEV) {
          console.warn(
            'pty.spawn.font-fallback',
            '[usePtySession] document.fonts.ready が 300ms で resolve しなかったため fallback metrics で spawn しました。useFitToContainer の fonts.ready effect が後追い refit します。'
          );
        }
        if (localDisposed || disposedRef.current) return;
      }

      // 初期サイズ算出。Canvas モード (unscaledFit=true) では `transform: scale(zoom)` 下で
      // FitAddon.fit() が getBoundingClientRect 経由で scale 後の視覚矩形を読んでしまうため、
      // 論理 px (clientWidth/clientHeight) と zoom 非依存のセルメトリクスから cols/rows を
      // 算出して term.resize() する。Issue #253 P6 の主因対策。
      // unscaled モードでは IDE 経路 (fit.fit()) に**絶対に**フォールバックしない
      // (transform 後矩形を読んで主因が再発するため)。grid 算出失敗時は xterm デフォルトの
      // 80x24 のまま続行 (後続の useFitToContainer.refit が補正)。
      try {
        if (unscaledFitRef.current) {
          const container = containerRefRef.current?.current;
          const cell = getCellSizeRef.current?.();
          if (container && cell) {
            const grid = computeUnscaledGrid(
              container.clientWidth,
              container.clientHeight,
              cell.cellW,
              cell.cellH
            );
            if (grid) {
              term.resize(grid.cols, grid.rows);
              initialCols = grid.cols;
              initialRows = grid.rows;
              // useFitToContainer の lastScheduledRef を seed して、30ms 後 visible-effect
              // の二重 IPC 発火を抑止する。
              const sharedRef = lastScheduledRefRef.current;
              if (sharedRef) {
                sharedRef.current = { cols: grid.cols, rows: grid.rows };
              }
            }
          }
        } else {
          fit?.fit();
          initialCols = term.cols;
          initialRows = term.rows;
        }
      } catch {
        /* 非表示マウント時は失敗してもOK */
      }
    };

    // === Helper 2: attemptPreSubscribe ===
    // Issue #285: 新規 spawn の race fix — `terminal_create` を呼ぶ前に
    // `terminal:data:{id}` 等を listen() 完了まで待ってから create する。
    // 戻り値: true = 購読成功 / false = 中断 (caller は早期 return)。
    // 中断時は内部で unsubscribePtyListeners() を呼ぶ。
    const attemptPreSubscribe = async (
      targetId: string,
      dataCb: (d: string) => void,
      exitCb: (i: TerminalExitInfo) => void,
      sidCb: (s: string) => void
    ): Promise<boolean> => {
      offData = await window.api.terminal.onDataReady(targetId, dataCb);
      offExit = await window.api.terminal.onExitReady(targetId, exitCb);
      offSessionId = await window.api.terminal.onSessionIdReady(targetId, sidCb);
      if (localDisposed || disposedRef.current) {
        unsubscribePtyListeners();
        return false;
      }
      return true;
    };

    // === Helper 3: setupPostSubscribe ===
    // attach 経路 (HMR remount): pre-subscribe を skip しているのでここで sync
    // post-subscribe する。PTY は既に動作中で startup race は起きないため
    // post-subscribe で十分。新規 spawn 経路では既に offData 等が埋まっているので
    // 各 if ガードで no-op になる。
    const setupPostSubscribe = (resId: string, attached: boolean): void => {
      if (!offData) {
        offData = window.api.terminal.onData(resId, (data) => {
          if (!isCurrentGeneration()) return;
          term.write(data);
          if (data.includes('\n') || data.includes('\r') || data.length >= 4096) {
            scheduleRenderRepair();
          }
          callbacksRef.current.onActivity?.();
          // Issue #271: attach 復帰時は observeChunkRef を起動しない (initialMessage 二重送信防止)。
          if (!attached) {
            observeChunkRef.current(data);
          }
        });
      }
      if (!offExit) {
        offExit = window.api.terminal.onExit(resId, (info) => {
          if (!isCurrentGeneration()) return;
          term.writeln(
            `\r\n\x1b[33m[プロセス終了: exitCode=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ''}]\x1b[0m`
          );
          callbacksRef.current.onStatus?.(`終了 (exitCode=${info.exitCode})`);
          ptyIdRef.current = null;
          if (skey) {
            const c = getHmrPtyCache();
            if (c) delete c[skey];
          }
          callbacksRef.current.onExit?.();
        });
      }
      if (!offSessionId) {
        // セッション id は main プロセスが `~/.claude/projects/.../*.jsonl` の
        // 差分から検出し、`terminal:sessionId:<id>` で通知してくる。
        offSessionId = window.api.terminal.onSessionId(resId, (sessionId) => {
          if (!isCurrentGeneration()) return;
          try {
            callbacksRef.current.onSessionId?.(sessionId);
          } catch {
            /* noop */
          }
        });
      }
    };

    (async () => {
      try {
        await loadInitialMetrics();
        if (localDisposed || disposedRef.current) return;

        callbacksRef.current.onStatus?.(`${command} を起動中…`);
        // 不変式 #2: 初回 spawn 時点のスナップショットを使う (以後の prop 変化は無視)
        const snap = snapRef.current;
        // Issue #271: HMR remount 経路では `import.meta.hot.data.ptyBySessionKey`
        // に前世代の ptyId が残っている。`attachIfExists` を真にするのは
        // 「dev で HMR が動いていて、かつ cache に有効な ptyId が残っている場合」だけ。
        const cache = getHmrPtyCache();
        const cachedPtyId = cache && skey ? cache[skey]?.ptyId : undefined;
        const wantAttach = Boolean(skey && cachedPtyId);

        // 新規 spawn (= attached false) 用の listener コールバック群。
        // pre-subscribe / mismatch re-subscribe で同じ実装を使い回すために effect-local
        // closure として 1 度だけ作る。`isCurrentGeneration` で世代外 (HMR 旧世代) を
        // 弾き、observeChunk (auto-initial-message の ready 検出) は常に呼ぶ。
        const newSpawnDataCb = (data: string): void => {
          if (!isCurrentGeneration()) return;
          term.write(data);
          if (data.includes('\n') || data.includes('\r') || data.length >= 4096) {
            scheduleRenderRepair();
          }
          callbacksRef.current.onActivity?.();
          observeChunkRef.current(data);
        };
        const newSpawnExitCb = (info: TerminalExitInfo): void => {
          if (!isCurrentGeneration()) return;
          term.writeln(
            `\r\n\x1b[33m[プロセス終了: exitCode=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ''}]\x1b[0m`
          );
          callbacksRef.current.onStatus?.(`終了 (exitCode=${info.exitCode})`);
          ptyIdRef.current = null;
          if (skey) {
            const c = getHmrPtyCache();
            if (c) delete c[skey];
          }
          callbacksRef.current.onExit?.();
        };
        const newSpawnSessionIdCb = (sessionId: string): void => {
          if (!isCurrentGeneration()) return;
          try {
            callbacksRef.current.onSessionId?.(sessionId);
          } catch {
            /* noop */
          }
        };

        // client-generated id: Rust 側で文字種検証 + 既存衝突チェックを通る。
        // crypto.randomUUID は Tauri 2 の WebView (Edge WebView2 / WKWebView) では
        // 必ず使えるが、安全側で文字列フォールバックを残す。
        const requestedId =
          wantAttach
            ? null
            : typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `term-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        if (requestedId) {
          const ok = await attemptPreSubscribe(
            requestedId,
            newSpawnDataCb,
            newSpawnExitCb,
            newSpawnSessionIdCb
          );
          if (!ok) return;
        }

        const res = await window.api.terminal.create({
          id: requestedId ?? undefined,
          cwd,
          fallbackCwd,
          command,
          args: snap.args,
          cols: initialCols,
          rows: initialRows,
          env: snap.env,
          teamId: snap.teamId,
          agentId: snap.agentId,
          role: snap.role,
          sessionKey: skey,
          attachIfExists: wantAttach,
          codexInstructions: snap.codexInstructions
        });

        if (localDisposed || disposedRef.current) {
          // 古い effect の戻り値だった場合の race 処理。
          // - 通常 cleanup (タブ close / restart): kill する
          // - HMR cleanup (hmrDisposeArmed.current = true 中): kill せず cache に id を残し、
          //   次の remount で attach できるようにする
          unsubscribePtyListeners();
          if (res.ok && res.id) {
            if (hmrDisposeArmed.current && skey) {
              const c = getHmrPtyCache();
              if (c) c[skey] = { ptyId: res.id, generation: myGeneration };
            } else {
              void window.api.terminal.kill(res.id);
            }
          }
          return;
        }

        if (!res.ok || !res.id) {
          // pre-subscribe 経路で create が失敗した場合は orphan listener を必ず解除。
          unsubscribePtyListeners();
          const errMsg = res.error ?? '不明なエラー';
          term.writeln(`\x1b[31m[起動エラー] ${errMsg}\x1b[0m`);
          callbacksRef.current.onStatus?.(`起動失敗: ${res.error ?? ''}`);
          // Issue #342 Phase 1: recruit 経路から呼ばれた spawn なら、Hub に失敗を ack して
          // 30 秒の handshake timeout を待たず即座に構造化エラーで返せるようにする。
          callbacksRef.current.onSpawnError?.(errMsg);
          return;
        }

        // Issue #285: 新規 spawn 経路 (requestedId !== null) では Rust 側が
        // `is_valid_terminal_id` か registry 衝突で UUID 再生成にフォールバックする
        // 稀ケースがある。万一 mismatch したら、pre-subscribe したリスナーは別 id
        // (誰も emit しない死 channel) を購読してしまっているので、`res.id` で
        // 再 pre-subscribe (`*Ready`) する。post-subscribe (sync) だと初期出力を
        // 取り逃がしうる (Issue #285 の元症状) ので必ず *Ready で再 await。
        if (requestedId && res.id !== requestedId) {
          unsubscribePtyListeners();
          const ok = await attemptPreSubscribe(
            res.id,
            newSpawnDataCb,
            newSpawnExitCb,
            newSpawnSessionIdCb
          );
          if (!ok) {
            void window.api.terminal.kill(res.id);
            return;
          }
        }

        ptyIdRef.current = res.id;
        // Issue #271: HMR remount で再 attach できるよう ptyId と世代番号を退避。
        if (skey) {
          const c = getHmrPtyCache();
          if (c) {
            c[skey] = { ptyId: res.id, generation: myGeneration };
          }
        }
        if (res.warning) {
          term.writeln(`\x1b[33m[警告] ${res.warning}\x1b[0m`);
        }
        const attached = res.attached === true;

        // Issue #285 follow-up: attach 経路の race と表示順序を両立させる設計。
        //
        // 問題 1 (Codex Lane 0): snapshot 取得 〜 renderer 側 listener ready の間に届いた新着が lost
        // 問題 2 (Codex Lane 3): listener ready 〜 term.write(replay) の間の新着が replay より先に描画 → 順序逆転
        //
        // 解決:
        //   (a) listener を *Ready で張ることで「create return 後の新着は必ず受信される」を保証
        //   (b) listener callback は最初の payload を「buffering 用 queue」に溜め、term.write はしない
        //   (c) replay snapshot を term.write してから queue を順次 flush する
        //   (d) flush 完了後 callback の挙動を「直接 term.write」に切替える
        //
        // この順序で:
        //   - replay (snapshot 時点までの過去出力) が先に画面に書かれる
        //   - その後 queue に溜まっていた「snapshot 後 〜 buffering 切替後」の新着が順序通り flush される
        //   - 以降の通常 listener が直接 term.write する
        //
        // 注: snapshot 末尾と queue 先頭が一部 byte レベルで重複する可能性はあるが、
        // それは「終端 prompt の再描画」程度で機能性には影響しない (xterm の re-render で吸収される)。
        if (attached) {
          unsubscribePtyListeners();

          // (b) attach 経路 listener: 最初は queue に溜める、flush 後は直接 write。
          let attachQueue: string[] = [];
          let attachQueueFlushed = false;
          const writeOrQueue = (data: string): void => {
            if (!isCurrentGeneration()) return;
            if (!attachQueueFlushed) {
              attachQueue.push(data);
              return;
            }
            term.write(data);
            if (data.includes('\n') || data.includes('\r') || data.length >= 4096) {
              scheduleRenderRepair();
            }
            callbacksRef.current.onActivity?.();
          };

          // (a) *Ready で listener 登録を await。create return 後の payload は確実に受信される。
          const ok = await attemptPreSubscribe(
            res.id,
            writeOrQueue,
            (info) => {
              if (!isCurrentGeneration()) return;
              term.writeln(
                `\r\n\x1b[33m[プロセス終了: exitCode=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ''}]\x1b[0m`
              );
              callbacksRef.current.onStatus?.(`終了 (exitCode=${info.exitCode})`);
              ptyIdRef.current = null;
              if (skey) {
                const c = getHmrPtyCache();
                if (c) delete c[skey];
              }
              callbacksRef.current.onExit?.();
            },
            (sessionId) => {
              if (!isCurrentGeneration()) return;
              try {
                callbacksRef.current.onSessionId?.(sessionId);
              } catch {
                /* noop */
              }
            }
          );
          if (!ok) return;

          // (c) listener が queue モードで動いている状態で replay を term.write。
          if (res.replay && res.replay.length > 0) {
            try {
              term.write(res.replay);
            } catch {
              /* xterm が dispose 済み等の例外は握りつぶす (replay は best-effort) */
            }
          }

          // (d) queue を順次 flush して、以降は直接 write モードに切替える。
          //     queue 中身は snapshot 取得後 〜 ここまでの新着なので、replay の **後** に来るのが正しい順序。
          for (const chunk of attachQueue) {
            try {
              term.write(chunk);
            } catch {
              /* dispose 済みは無視 */
            }
          }
          attachQueue = [];
          attachQueueFlushed = true;

          // UI 通知は status ラインのみ。xterm buffer に UI メッセージを書き込まない (Codex Lane 1)。
          callbacksRef.current.onStatus?.(
            res.replay && res.replay.length > 0
              ? `再接続 (出力復元): ${res.command ?? command}`
              : `再接続: ${res.command ?? command}`
          );
        } else {
          // 新規 spawn 経路: pre-subscribe 済みの listener はそのまま使う。
          // setupPostSubscribe は新規 spawn では if (!offData) ガードで no-op になるが、
          // 互換性と将来の post-subscribe 経路フォールバック用に呼んでおく。
          callbacksRef.current.onStatus?.(`実行中: ${res.command ?? command}`);
          setupPostSubscribe(res.id, attached);
        }
      } catch (err) {
        // Issue #285 self-review: 例外発生から effect cleanup までの窓で pre-subscribe
        // した listener が orphan になるのを防ぐため、catch でも明示的に解除する。
        unsubscribePtyListeners();
        try {
          term.writeln(`\x1b[31m[例外] ${String(err)}\x1b[0m`);
        } catch {
          /* term が dispose 済み等で writeln 自体が落ちる可能性に備える */
        }
        callbacksRef.current.onStatus?.(`例外: ${String(err)}`);
      }
    })();

    // IME composition 中は onData を抑制して候補ウィンドウの位置ジャンプを防ぐ
    let composing = false;
    const textarea = term.textarea;
    const onCompStart = (): void => { composing = true; };
    const onCompEnd = (): void => { composing = false; };
    textarea?.addEventListener('compositionstart', onCompStart);
    textarea?.addEventListener('compositionend', onCompEnd);

    // キー入力 → pty へ
    const dataSub = term.onData((data) => {
      if (composing) return;
      if (ptyIdRef.current) {
        void window.api.terminal.write(ptyIdRef.current, data);
      }
      try {
        callbacksRef.current.onUserInput?.(data);
      } catch {
        /* noop */
      }
    });

    return () => {
      localDisposed = true;
      disposedRef.current = true;
      dataSub.dispose();
      textarea?.removeEventListener('compositionstart', onCompStart);
      textarea?.removeEventListener('compositionend', onCompEnd);
      // Issue #271: HMR cleanup と通常 unmount を厳密に区別する。
      //   - `hmrDisposeArmed.current === true` のとき: Vite が hot.dispose() の cb を
      //     呼んだ直後 (= HMR が module を捨てる経路) なので、kill せず cache に残す。
      //   - false のとき: 通常 unmount (タブ close / restart の version 変更 / カード削除
      //     等) なので、従来通り kill して cache も掃除する。
      //   このフラグは本ファイルの module-scope で hot.dispose() cb が立てる。次の
      //   mount 時の effect 冒頭で false に戻す。タイマーは使わないので React Refresh
      //   の cleanup がいつ走っても判定がブレない。
      const skeyAtCleanup = sessionKeyRef.current;
      const hmrCleanup = hmrDisposeArmed.current && Boolean(skeyAtCleanup);
      offData?.();
      offExit?.();
      offSessionId?.();
      if (repairFrame !== null) {
        window.cancelAnimationFrame(repairFrame);
        repairFrame = null;
      }
      if (ptyIdRef.current) {
        if (hmrCleanup) {
          // HMR cleanup: kill せず HMR cache に最新 id を残しておく (mount 直後の
          // 確定保存を上書き保存する形)。次の remount で `attachIfExists: true` で
          // この id に attach される。
          const c = getHmrPtyCache();
          if (c && skeyAtCleanup) {
            c[skeyAtCleanup] = { ptyId: ptyIdRef.current, generation: myGeneration };
          }
          ptyIdRef.current = null;
        } else {
          // 通常 cleanup (本番ビルド or sessionKey 無し): kill して cache も掃除。
          void window.api.terminal.kill(ptyIdRef.current);
          ptyIdRef.current = null;
          if (skeyAtCleanup) {
            const c = getHmrPtyCache();
            if (c) delete c[skeyAtCleanup];
          }
        }
      }
    };
    // 不変式 #1: deps は [cwd, command] のみ。
    // 他の props/callbacks/refs は意図的に依存配列から除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command]);
}
