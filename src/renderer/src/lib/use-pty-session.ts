import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
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
 * Issue #271: HMR dispose 経路で「kill しない」フラグの記録先。
 *   - Vite HMR は `import.meta.hot.dispose(cb)` の cb を「remount 直前」に呼ぶ。
 *   - cb 内で `inProgress = true` にしておくと、その直後にレンダーツリーが
 *     unmount され本フックの cleanup が走る。cleanup は `inProgress` を見て
 *     `terminal.kill` を skip し、ptyId を `import.meta.hot.data` に退避する。
 *   - 直後の re-mount で hook は再度起動 → `import.meta.hot.data` に残った
 *     ptyId を見て、`attachIfExists: true` で bind だけやり直す。
 *
 * 通常のタブ close / restart / コンポーネント mount/unmount では `inProgress`
 * は false のままなので、従来通り kill が走る。HMR を持たない本番ビルドでは
 * `import.meta.hot` が undefined なので分岐自体が無効化される。
 */
const hmrDisposeInProgress: { current: boolean } = { current: false };

interface HmrPtyCacheEntry {
  ptyId: string;
  generation: number;
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

// dev のみ: HMR dispose hook を 1 回だけ登録する。
// この cb が走った後に各 useEffect の cleanup が呼ばれるので、cleanup 側は
// `hmrDisposeInProgress.current` を見て kill skip を判断できる。
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
    hmrDisposeInProgress.current = true;
    // 次の module 評価 (= remount 後) でフラグを下ろす。微小な setTimeout で
    // 「cleanup → remount → effect 走り出し」を跨ぐ。
    setTimeout(() => {
      hmrDisposeInProgress.current = false;
    }, 0);
  });
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

    (async () => {
      try {
        // Issue #253 review (W#1 + #3 + #4): web font (JetBrains Mono Variable 等) ロード前に
        // measureCellSize が走ると system monospace のメトリクスを返し、誤った cellW で
        // PTY が立つ。Canvas モードでは fonts.ready を待ってから測ることで、Codex の
        // banner も初回描画から正しい寸法で描画される。IDE モードでは fit.fit() が DOM
        // メトリクスベースなので待つ必要なし。
        // タイムアウト 300ms: コールドキャッシュ / 低速 I/O 環境で fonts.ready が秒オーダー
        // で resolve しないとき spawn が体感遅延する問題を回避。300ms 経過時は fallback
        // メトリクスで spawn し、後続の useFitToContainer の fonts.ready effect が ready 後
        // 1 回だけ refit を発火して補正するので、一瞬だけずれた表示も自動回復する。
        // 旧 500ms から短縮 (review #4): 体感遅延を抑え、fallback 経路は dev console.warn で
        // 観測可能にして頻発するなら別 PR で fonts.load(specific) 等への切替を検討する。
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

        // 初期サイズ算出。
        // Canvas モード (unscaledFit=true) では、`transform: scale(zoom)` 下で
        // FitAddon.fit() が getBoundingClientRect 経由で scale 後の視覚矩形を読んでしまうため、
        // 論理 px (clientWidth/clientHeight) と zoom 非依存のセルメトリクスから cols/rows を
        // 算出して term.resize() する。Issue #253 P6 の主因対策。
        // Review #4 + #5: unscaled モードでは IDE 経路 (fit.fit()) に**絶対に**フォールバック
        // しない。fit.fit() を呼ぶと transform 後矩形を読んでしまい主因 P6 が一瞬だけ再発する
        // ため、grid 算出失敗時は xterm デフォルトの 80x24 のまま続行する (後続の
        // useFitToContainer.refit が論理 px 経路で 30ms 以内に補正するので実害なし)。
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
              // grid 算出失敗 → 80x24 のまま続行 (Review #5)
            }
            // container/cell 不在も同様 80x24 のまま続行 (Review #4)
          } else {
            fit?.fit();
            initialCols = term.cols;
            initialRows = term.rows;
          }
        } catch {
          /* 非表示マウント時は失敗してもOK */
        }

        callbacksRef.current.onStatus?.(`${command} を起動中…`);
        // 不変式 #2: 初回 spawn 時点のスナップショットを使う (以後の prop 変化は無視)
        const snap = snapRef.current;
        // Issue #271: HMR remount 経路では `import.meta.hot.data.ptyBySessionKey`
        // に前世代の ptyId が残っている。Rust 側 preflight は `find_attach_target` で
        // session_key / agent_id を引いて生存 PTY を返してくるので、こちらから
        // sessionKey と attachIfExists を載せて呼ぶだけで attach 経路に乗る。
        // sessionKey が無い場合は従来通り常に新規 spawn。
        const skey = sessionKeyRef.current;
        const res = await window.api.terminal.create({
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
          attachIfExists: Boolean(skey),
          codexInstructions: snap.codexInstructions
        });

        if (localDisposed || disposedRef.current) {
          // 古い effect の戻り値だった場合、spawn 済みの pty は責任を持って kill
          if (res.ok && res.id) {
            void window.api.terminal.kill(res.id);
          }
          return;
        }

        if (!res.ok || !res.id) {
          term.writeln(`\x1b[31m[起動エラー] ${res.error ?? '不明なエラー'}\x1b[0m`);
          callbacksRef.current.onStatus?.(`起動失敗: ${res.error ?? ''}`);
          return;
        }

        ptyIdRef.current = res.id;
        // Issue #271: HMR remount で再 attach できるよう ptyId と世代番号を退避。
        if (skey) {
          const cache = getHmrPtyCache();
          if (cache) {
            cache[skey] = { ptyId: res.id, generation: myGeneration };
          }
        }
        if (res.warning) {
          term.writeln(`\x1b[33m[警告] ${res.warning}\x1b[0m`);
        }
        callbacksRef.current.onStatus?.(
          res.attached
            ? `再接続: ${res.command ?? command}`
            : `実行中: ${res.command ?? command}`
        );

        const isCurrentGeneration = (): boolean => {
          if (!skey) return true;
          const cache = getHmrPtyCache();
          if (!cache) return true;
          // 自分が登録した世代と一致するか確認 (古い世代の listener なら無視)
          return cache[skey]?.generation === myGeneration;
        };

        // セッション id は main プロセスが `~/.claude/projects/.../*.jsonl` の
        // 差分から検出し、`terminal:sessionId:<id>` で通知してくる。
        offSessionId = window.api.terminal.onSessionId(res.id, (sessionId) => {
          if (!isCurrentGeneration()) return;
          try {
            callbacksRef.current.onSessionId?.(sessionId);
          } catch {
            /* noop */
          }
        });

        offData = window.api.terminal.onData(res.id, (data) => {
          if (!isCurrentGeneration()) return;
          term.write(data);
          if (data.includes('\n') || data.includes('\r') || data.length >= 4096) {
            scheduleRenderRepair();
          }
          callbacksRef.current.onActivity?.();
          observeChunkRef.current(data);
        });

        offExit = window.api.terminal.onExit(res.id, (info) => {
          if (!isCurrentGeneration()) return;
          term.writeln(
            `\r\n\x1b[33m[プロセス終了: exitCode=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ''}]\x1b[0m`
          );
          callbacksRef.current.onStatus?.(`終了 (exitCode=${info.exitCode})`);
          ptyIdRef.current = null;
          // Issue #271: 終了した PTY は HMR cache からも消す (以後 attach 不可)。
          if (skey) {
            const cache = getHmrPtyCache();
            if (cache) delete cache[skey];
          }
          callbacksRef.current.onExit?.();
        });
      } catch (err) {
        term.writeln(`\x1b[31m[例外] ${String(err)}\x1b[0m`);
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
      // Issue #271: HMR dispose 中は kill を skip する (PTY は生かしたまま remount 後に再 bind)。
      // 通常 unmount (タブ close / カード削除 / restart) では kill する。
      const skeyAtCleanup = sessionKeyRef.current;
      const isHmrDispose = hmrDisposeInProgress.current;
      offData?.();
      offExit?.();
      offSessionId?.();
      if (repairFrame !== null) {
        window.cancelAnimationFrame(repairFrame);
        repairFrame = null;
      }
      if (ptyIdRef.current) {
        if (isHmrDispose && skeyAtCleanup) {
          // HMR cleanup: kill せず HMR cache に id を残し、remount 側で attach させる。
          // ptyBySessionKey のエントリは初回 spawn 直後に既に保存済み。
          // ここでは「ptyIdRef を null にしないこと」で、次の remount まで参照を保持する
          // 必要はない (remount 時の preflight で再取得するため)。
          // 旧 listener は世代番号で無視されるので、ptyIdRef は今 null にしてよい。
          ptyIdRef.current = null;
        } else {
          // 通常 cleanup: kill して HMR cache からも消す。
          void window.api.terminal.kill(ptyIdRef.current);
          ptyIdRef.current = null;
          if (skeyAtCleanup) {
            const cache = getHmrPtyCache();
            if (cache) delete cache[skeyAtCleanup];
          }
        }
      }
    };
    // 不変式 #1: deps は [cwd, command] のみ。
    // 他の props/callbacks/refs は意図的に依存配列から除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command]);
}
