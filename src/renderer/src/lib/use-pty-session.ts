import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface PtySpawnSnapshot {
  args?: string[];
  env?: Record<string, string>;
  teamId?: string;
  agentId?: string;
  role?: string;
  initialMessage?: string | string[];
}

export interface PtySessionCallbacks {
  onStatus?: (status: string) => void;
  onActivity?: () => void;
  onExit?: () => void;
  onSessionId?: (sessionId: string) => void;
}

export interface UsePtySessionOptions {
  cwd: string;
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
    command,
    termRef,
    fitRef,
    snapRef,
    callbacksRef,
    ptyIdRef,
    disposedRef,
    observeChunk
  } = options;

  const observeChunkRef = useRef(observeChunk);
  observeChunkRef.current = observeChunk;

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;

    disposedRef.current = false;

    // 初期サイズ調整
    let initialCols = 80;
    let initialRows = 24;
    try {
      fit?.fit();
      initialCols = term.cols;
      initialRows = term.rows;
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
          command,
          args: snap.args,
          cols: initialCols,
          rows: initialRows,
          env: snap.env,
          teamId: snap.teamId,
          agentId: snap.agentId,
          role: snap.role
        });

        if (disposedRef.current) return;

        if (!res.ok || !res.id) {
          term.writeln(`\x1b[31m[起動エラー] ${res.error ?? '不明なエラー'}\x1b[0m`);
          callbacksRef.current.onStatus?.(`起動失敗: ${res.error ?? ''}`);
          return;
        }

        ptyIdRef.current = res.id;
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

    // キー入力 → pty へ
    const dataSub = term.onData((data) => {
      if (ptyIdRef.current) {
        void window.api.terminal.write(ptyIdRef.current, data);
      }
    });

    return () => {
      disposedRef.current = true;
      dataSub.dispose();
      offData?.();
      offExit?.();
      offSessionId?.();
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
