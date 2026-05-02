import { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { useSettings } from '../lib/settings-context';
import { useT } from '../lib/i18n';
import { useXtermInstance } from '../lib/use-xterm-instance';
import {
  usePtySession,
  type PtySessionCallbacks,
  type PtySpawnSnapshot
} from '../lib/use-pty-session';
import { useTerminalClipboard } from '../lib/use-terminal-clipboard';
import { useAutoInitialMessage } from '../lib/use-auto-initial-message';
import { useFitToContainer } from '../lib/use-fit-to-container';
import type { CellSize } from '../lib/measure-cell-size';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

/**
 * TerminalView を外から操作するためのハンドル。
 * 親が ref で握って sendCommand を呼び出すと pty に書き込まれる。
 */
export interface TerminalViewHandle {
  /** 文字列を pty に送る。`submit: true` なら末尾に `\r` を付けて Enter 相当 */
  sendCommand(text: string, submit?: boolean): void;
  /** ターミナルへフォーカスを移す */
  focus(): void;
  /** xterm の scroll model に基づき末尾までスクロールする (Issue #272 v3) */
  scrollToBottom(): void;
  /** 現在の xterm buffer 末尾をプレーンテキストで返す (handoff 用) */
  getBufferText(maxLines?: number): string;
}

interface TerminalViewProps {
  cwd: string;
  /** `cwd` が無効な場合のフォールバック(通常はプロジェクトルートを渡す) */
  fallbackCwd?: string;
  command: string;
  /**
   * Issue #271: HMR remount 時に同じ PTY へ再 bind するための論理キー。
   * IDE: `term:${tab.id}`、Canvas TerminalCard: `canvas-term:${node.id}`、
   * Canvas AgentNodeCard: `canvas-agent:${node.id}` のような安定文字列を渡す。
   * 値があると Vite HMR で React Refresh が unmount/remount してもターミナルが
   * 一斉終了せず、既存の PTY に再接続する。本番ビルドでは何の影響もない。
   */
  sessionKey?: string;
  args?: string[];
  /** pty に渡す追加の環境変数 */
  env?: Record<string, string>;
  /** TeamHub 用のチーム識別子 */
  teamId?: string;
  /** 現在このペインが表示されているか（非表示時は fit をスキップ） */
  visible: boolean;
  /** 起動後に自動送信するメッセージ（配列なら順番に送信） */
  initialMessage?: string | string[];
  /** TeamHub 用のエージェント識別子 */
  agentId?: string;
  /** TeamHub のメッセージ注入時に from として表示されるロール */
  role?: string;
  /** Codex 起動時にシステム指示として渡す文字列（main で一時ファイル化） */
  codexInstructions?: string;
  /** 起動中 / エラー表示用のコールバック */
  onStatus?: (status: string) => void;
  /** 出力イベント（非可視時のバッジ表示用） */
  onActivity?: () => void;
  /** プロセス終了通知 */
  onExit?: () => void;
  /** Claude Code の起動ログから session id を抽出したとき（初回1回のみ） */
  onSessionId?: (sessionId: string) => void;
  /** ユーザーが xterm 上で入力したキーストロークの sniff (タイトル auto-summary 等の用途) */
  onUserInput?: (data: string) => void;
  /**
   * Issue #342 Phase 1: terminal_create の spawn 失敗時に呼ばれる。
   * AgentNodeCard などが本コールバックで `ackRecruit` を発火し、recruit timeout
   * (>30s) を待たず即座に Hub へ失敗を通知できる。recruit 経路に紐付かない通常
   * タブでは未指定で OK (no-op)。
   */
  onSpawnError?: (error: string) => void;
  /**
   * Canvas モードのカード内で使うとき true にする。
   * WebglAddon を読み込まず DOM renderer に固定することで、React Flow の親 transform
   * で xterm が滲む問題を回避する。
   */
  disableWebgl?: boolean;
  /**
   * Issue #272 v4: Canvas モード限定で、マウスホイールを xterm の scrollback スクロールへ
   * 強制ルーティングする。`term.attachCustomWheelEventHandler` 経由で normal buffer +
   * scrollback ありの時のみ `term.scrollLines()` を発火させる。
   * alt buffer (vim/less/htop) や Ctrl/Shift wheel は xterm 既定動作のまま (TUI 側に届く)。
   */
  forceWheelScrollback?: boolean;
  /**
   * Issue #253: Canvas モード (transform: scale(zoom) 配下) で論理 px ベース fit を有効化。
   * true にすると getBoundingClientRect 経由ではなく container.clientWidth/clientHeight と
   * `getCellSize()` から cols/rows を直接計算するので、zoom が変わっても PTY サイズが安定する。
   */
  unscaledFit?: boolean;
  /** unscaled fit で使うセルメトリクス取得関数 (フォント変更を毎回拾うため関数で渡す) */
  getCellSize?: () => CellSize | null;
  /** Canvas zoom の購読関数 (量子化 + cb 発火)。返値は unsubscribe */
  zoomSubscribe?: (cb: () => void) => () => void;
  /** 可観測性ログ用の zoom 取得 */
  getZoom?: () => number;
}

/**
 * xterm.js + node-pty(IPC) でインタラクティブターミナルを描画する。
 *
 * 実装はフックに分解されている:
 *   - useXtermInstance     : Terminal + FitAddon のライフサイクル (mount-scoped)
 *   - usePtySession        : pty spawn / onData / onExit / kill (cwd/command-scoped)
 *   - useAutoInitialMessage: ready 検出と initialMessage 順送信
 *   - useTerminalClipboard : Ctrl+C / Ctrl+V / 画像ペースト
 *   - useFitToContainer    : ResizeObserver + 可視化時 re-fit
 */
export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(
    {
      cwd,
      fallbackCwd,
      command,
      sessionKey,
      args,
      env,
      teamId,
      visible,
      initialMessage,
      agentId,
      role,
      codexInstructions,
      onStatus,
      onActivity,
      onExit,
      onSessionId,
      onUserInput,
      onSpawnError,
      disableWebgl,
      forceWheelScrollback,
      unscaledFit,
      getCellSize,
      zoomSubscribe,
      getZoom
    },
    ref
  ): JSX.Element {
    const { settings } = useSettings();
    const t = useT();
    // Issue #338: useTerminalClipboard が React Context を直接引かないように、言語の current を
    // ref で渡す。settings 変化のたびに同期するので stale にならない。
    const langRef = useRef(settings.language);
    langRef.current = settings.language;

    // Issue #356: 右クリックコンテキストメニュー (paste / copy selection / clear)。
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
      items: ContextMenuItem[];
    } | null>(null);

    // --- Terminal インスタンス ---
    const { containerRef, termRef, fitRef } = useXtermInstance(
      settings,
      disableWebgl,
      forceWheelScrollback
    );

    // --- ref で state を hook 間共有 ---
    const ptyIdRef = useRef<string | null>(null);
    const disposedRef = useRef(false);
    // Issue #253 sub (H1): usePtySession の初回 spawn で seed されると、useFitToContainer の
    // 30ms 後 visible-effect refit が同じ cols/rows を計算したとき dedupe で IPC を skip する。
    // これにより SIGWINCH の二重発火を防ぐ。
    const lastScheduledRef = useRef<{ cols: number; rows: number } | null>(null);

    // 不変式 #2: args / env / teamId / agentId / role / initialMessage は
    // spawn 時に一度だけ使う値。ref 経由で usePtySession 内部に渡す。
    const snapRef = useRef<PtySpawnSnapshot>({
      args,
      env,
      teamId,
      agentId,
      role,
      initialMessage,
      codexInstructions
    });
    snapRef.current = {
      args,
      env,
      teamId,
      agentId,
      role,
      initialMessage,
      codexInstructions
    };

    // useAutoInitialMessage は snap とは別に initialMessage を再参照するので ref を渡す
    const initialMessageRef = useRef(initialMessage);
    initialMessageRef.current = initialMessage;

    // callbacks は毎レンダー更新されるので ref で安定化
    const callbacksRef = useRef<PtySessionCallbacks>({
      onStatus,
      onActivity,
      onExit,
      onSessionId,
      onUserInput,
      onSpawnError
    });
    callbacksRef.current = {
      onStatus,
      onActivity,
      onExit,
      onSessionId,
      onUserInput,
      onSpawnError
    };

    // --- 共通の write ヘルパ (closure で ptyIdRef を読む) ---
    const writeToPty = (text: string): void => {
      if (ptyIdRef.current) {
        void window.api.terminal.write(ptyIdRef.current, text);
      }
    };

    // --- initialMessage の自動送信 ---
    const { observeChunk } = useAutoInitialMessage({
      spawnKey: `${cwd}\0${command}`,
      initialMessageRef,
      isDisposed: () => disposedRef.current,
      writeToPty
    });

    // --- pty spawn / onData / onExit (不変式 #1: deps は cwd/command のみ) ---
    usePtySession({
      cwd,
      fallbackCwd,
      command,
      // Issue #271: HMR remount 時に同じ PTY へ再 bind するための論理キー。
      sessionKey,
      termRef,
      fitRef,
      snapRef,
      callbacksRef,
      ptyIdRef,
      disposedRef,
      observeChunk,
      // Issue #253: Canvas モードでは初回 spawn 時から unscaled な cols/rows を使う
      unscaledFit,
      getCellSize,
      containerRef,
      lastScheduledRef
    });

    // --- Ctrl+C / Ctrl+V / 画像ペースト (不変式 #4) ---
    useTerminalClipboard({
      termRef,
      containerRef,
      writeToPty,
      langRef
    });

    // --- ResizeObserver + 可視化時 re-fit (不変式 #5) ---
    // Issue #113: refitTriggers に terminalFontFamily が抜けていてフォント変更時に
    // ターミナルがリサイズされず文字幅が崩れていたので追加する。
    useFitToContainer({
      containerRef,
      termRef,
      fitRef,
      ptyIdRef,
      visible,
      refitTriggers: [
        settings.theme,
        settings.terminalFontFamily,
        settings.editorFontFamily,
        settings.terminalFontSize
      ],
      unscaledFit,
      getCellSize,
      zoomSubscribe,
      getZoom,
      lastScheduledRef
    });

    // Issue #356: 右クリックでカスタムメニューを開く。xterm 本体上の contextmenu を拾う。
    const handleContextMenu = useCallback(
      (e: React.MouseEvent): void => {
        const term = termRef.current;
        if (!term) return;
        e.preventDefault();
        e.stopPropagation();
        const selection = term.getSelection();
        const items: ContextMenuItem[] = [
          {
            label: t('terminal.ctxMenu.paste'),
            action: () => {
              void (async () => {
                try {
                  // 画像があれば clipboard event 経由 (use-terminal-clipboard) に任せ、
                  // ここではテキストペーストを優先する。
                  const text = await navigator.clipboard.readText();
                  if (text) term.paste(text);
                } catch {
                  /* noop */
                }
              })();
            }
          },
          {
            label: t('terminal.ctxMenu.copySelection'),
            action: () => {
              if (!selection) return;
              void navigator.clipboard.writeText(selection);
              term.clearSelection();
            },
            disabled: !selection,
            divider: true
          },
          {
            label: t('terminal.ctxMenu.clear'),
            action: () => term.clear()
          }
        ];
        setContextMenu({ x: e.clientX, y: e.clientY, items });
      },
      // termRef は stable
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [t]
    );

    const focusTerminal = useCallback((): void => {
      const term = termRef.current;
      term?.focus();
      if (term) {
        window.requestAnimationFrame(() => term.focus());
      }
    }, []);

    // --- 外部操作用ハンドル (public API は不変) ---
    useImperativeHandle(
      ref,
      () => ({
        sendCommand(text: string, submit = true): void {
          const id = ptyIdRef.current;
          if (!id) return;
          const payload = submit ? text + '\r' : text;
          void window.api.terminal.write(id, payload);
        },
        focus(): void {
          focusTerminal();
        },
        scrollToBottom(): void {
          termRef.current?.scrollToBottom();
        },
        getBufferText(maxLines = 80): string {
          const term = termRef.current;
          if (!term) return '';
          const buffer = term.buffer.active;
          const start = Math.max(0, buffer.length - maxLines);
          const lines: string[] = [];
          for (let i = start; i < buffer.length; i++) {
            lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
          }
          return lines.join('\n').trim();
        }
      }),
      [focusTerminal]
    );

    return (
      <>
        <div
          className="terminal-view"
          ref={containerRef}
          // Canvas の TerminalCard 内では、xterm のテキストエリアに focus が入らず
          // キー入力が届かない現象がある。空白領域をクリックしても明示的に focus を奪う。
          onPointerDownCapture={focusTerminal}
          onMouseDown={focusTerminal}
          onContextMenu={handleContextMenu}
        />
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenu.items}
            onClose={() => setContextMenu(null)}
          />
        )}
      </>
    );
  }
);
