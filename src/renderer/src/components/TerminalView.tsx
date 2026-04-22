import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useSettings } from '../lib/settings-context';
import { useXtermInstance } from '../lib/use-xterm-instance';
import {
  usePtySession,
  type PtySessionCallbacks,
  type PtySpawnSnapshot
} from '../lib/use-pty-session';
import { useTerminalClipboard } from '../lib/use-terminal-clipboard';
import { useAutoInitialMessage } from '../lib/use-auto-initial-message';
import { useFitToContainer } from '../lib/use-fit-to-container';

/**
 * TerminalView を外から操作するためのハンドル。
 * 親が ref で握って sendCommand を呼び出すと pty に書き込まれる。
 */
export interface TerminalViewHandle {
  /** 文字列を pty に送る。`submit: true` なら末尾に `\r` を付けて Enter 相当 */
  sendCommand(text: string, submit?: boolean): void;
  /** ターミナルへフォーカスを移す */
  focus(): void;
}

interface TerminalViewProps {
  cwd: string;
  /** `cwd` が無効な場合のフォールバック(通常はプロジェクトルートを渡す) */
  fallbackCwd?: string;
  command: string;
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
      onUserInput
    },
    ref
  ): JSX.Element {
    const { settings } = useSettings();

    // --- Terminal インスタンス ---
    const { containerRef, termRef, fitRef } = useXtermInstance(settings);

    // --- ref で state を hook 間共有 ---
    const ptyIdRef = useRef<string | null>(null);
    const disposedRef = useRef(false);

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
      onUserInput
    });
    callbacksRef.current = { onStatus, onActivity, onExit, onSessionId, onUserInput };

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
      termRef,
      fitRef,
      snapRef,
      callbacksRef,
      ptyIdRef,
      disposedRef,
      observeChunk
    });

    // --- Ctrl+C / Ctrl+V / 画像ペースト (不変式 #4) ---
    useTerminalClipboard({
      termRef,
      containerRef,
      writeToPty
    });

    // --- ResizeObserver + 可視化時 re-fit (不変式 #5) ---
    useFitToContainer({
      containerRef,
      termRef,
      fitRef,
      ptyIdRef,
      visible,
      refitTriggers: [
        settings.theme,
        settings.editorFontFamily,
        settings.terminalFontSize
      ]
    });

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
          termRef.current?.focus();
        }
      }),
      // ptyIdRef / termRef は stable な ref なので deps 不要
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    return (
      <div
        className="terminal-view"
        ref={containerRef}
        // Canvas の TerminalCard 内では、xterm のテキストエリアに focus が入らず
        // キー入力が届かない現象がある。空白領域をクリックしても明示的に focus を奪う。
        onMouseDown={() => termRef.current?.focus()}
      />
    );
  }
);
