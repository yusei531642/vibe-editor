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
}

/**
 * pty の spawn / データ購読 / 終了通知 / kill を一手に引き受けるフック。
 *
 * 不変式 #1: effect deps は `[cwd, command]` のみ。
 *   他の props (args / env / initialMessage / teamId / agentId / role) や
 *   callbacks は ref 経由で読むので deps に入れなくてよい。
 *   これにより並び替えや親コンポーネントの再レンダーで pty が巻き添え kill されない。
 *
 * 不変式 #2: 初回 spawn 時点の `args` / `env` / `initialMessage` を `snapRef` に
 *   退避してから `terminal.create` に渡す。以後 props が変化してもこの spawn には影響しない。
 */
export function usePtySession(options: UsePtySessionOptions): void {
  const {
    cwd,
    fallbackCwd,
    command,
    termRef,
    fitRef,
    snapRef,
    callbacksRef,
    ptyIdRef,
    disposedRef,
    observeChunk,
    unscaledFit = false,
    getCellSize,
    containerRef
  } = options;

  const observeChunkRef = useRef(observeChunk);
  observeChunkRef.current = observeChunk;

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

    // 初期サイズ調整。
    // Canvas モード (unscaledFit=true) では、`transform: scale(zoom)` 下で
    // FitAddon.fit() が getBoundingClientRect 経由で scale 後の視覚矩形を読んでしまうため、
    // 論理 px (clientWidth/clientHeight) と zoom 非依存のセルメトリクスから直接 cols/rows
    // を算出して term.resize() する。Issue #253 P6 の主因対策。
    let initialCols = 80;
    let initialRows = 24;
    try {
      const container = containerRef?.current;
      const cell = getCellSize?.();
      if (unscaledFit && container && cell) {
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
        } else {
          // grid 算出失敗 (container clientWidth=0 等) → 従来 fit にフォールバック
          fit?.fit();
          initialCols = term.cols;
          initialRows = term.rows;
        }
      } else {
        fit?.fit();
        initialCols = term.cols;
        initialRows = term.rows;
      }
    } catch {
      /* 非表示マウント時は失敗してもOK */
    }

    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let offSessionId: (() => void) | null = null;

    (async () => {
      try {
        callbacksRef.current.onStatus?.(`${command} を起動中…`);
        // 不変式 #2: 初回 spawn 時点のスナップショットを使う (以後の prop 変化は無視)
        const snap = snapRef.current;
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
        if (res.warning) {
          term.writeln(`\x1b[33m[警告] ${res.warning}\x1b[0m`);
        }
        callbacksRef.current.onStatus?.(`実行中: ${res.command ?? command}`);

        // セッション id は main プロセスが `~/.claude/projects/.../*.jsonl` の
        // 差分から検出し、`terminal:sessionId:<id>` で通知してくる。
        offSessionId = window.api.terminal.onSessionId(res.id, (sessionId) => {
          try {
            callbacksRef.current.onSessionId?.(sessionId);
          } catch {
            /* noop */
          }
        });

        offData = window.api.terminal.onData(res.id, (data) => {
          term.write(data);
          if (data.includes('\n') || data.includes('\r') || data.length >= 4096) {
            scheduleRenderRepair();
          }
          callbacksRef.current.onActivity?.();
          observeChunkRef.current(data);
        });

        offExit = window.api.terminal.onExit(res.id, (info) => {
          term.writeln(
            `\r\n\x1b[33m[プロセス終了: exitCode=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ''}]\x1b[0m`
          );
          callbacksRef.current.onStatus?.(`終了 (exitCode=${info.exitCode})`);
          ptyIdRef.current = null;
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
      offData?.();
      offExit?.();
      offSessionId?.();
      if (repairFrame !== null) {
        window.cancelAnimationFrame(repairFrame);
        repairFrame = null;
      }
      if (ptyIdRef.current) {
        void window.api.terminal.kill(ptyIdRef.current);
        ptyIdRef.current = null;
      }
    };
    // 不変式 #1: deps は [cwd, command] のみ。
    // 他の props/callbacks/refs は意図的に依存配列から除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command]);
}
