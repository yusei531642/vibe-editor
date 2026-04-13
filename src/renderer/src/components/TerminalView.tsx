import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSettings } from '../lib/settings-context';
import { THEMES } from '../lib/themes';

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
  /** 起動中 / エラー表示用のコールバック */
  onStatus?: (status: string) => void;
  /** 出力イベント（非可視時のバッジ表示用） */
  onActivity?: () => void;
  /** プロセス終了通知 */
  onExit?: () => void;
  /** Claude Code の起動ログから session id を抽出したとき（初回1回のみ） */
  onSessionId?: (sessionId: string) => void;
}

/**
 * xterm.js + node-pty(IPC) でインタラクティブターミナルを描画する。
 * マウント時に一度だけ pty を起動し、アンマウント時に終了する。
 * タブ切替で display:none になっても DOM から外れなければ pty は生存する。
 */
export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(
    { cwd, command, args, env, teamId, visible, initialMessage, agentId, role, onStatus, onActivity, onExit, onSessionId },
    ref
  ): JSX.Element {
  const { settings } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // コールバックは毎レンダーで新しい関数になるので ref で安定化
  const callbacksRef = useRef({ onStatus, onActivity, onExit, onSessionId });
  callbacksRef.current = { onStatus, onActivity, onExit, onSessionId };

  // args / env / teamId / agentId / role は spawn 時に一度だけ使う値。
  // 以後プロパティが変わっても pty を再起動しないよう ref に退避しておく。
  // （タブ並び替えでシステムプロンプトが再計算されるなどのケースで、
  //   生きている Claude Code セッションを巻き添えで殺さないための防御）
  const spawnPropsRef = useRef({ args, env, teamId, agentId, role, initialMessage });
  spawnPropsRef.current = { args, env, teamId, agentId, role, initialMessage };

  // 外部から TerminalView を操作するためのハンドル
  useImperativeHandle(
    ref,
    () => ({
      sendCommand(text: string, submit = true): void {
        if (!ptyIdRef.current) return;
        const payload = submit ? text + '\r' : text;
        void window.api.terminal.write(ptyIdRef.current, payload);
      },
      focus(): void {
        termRef.current?.focus();
      }
    }),
    []
  );

  // pty & terminal 初期化（cwd/command が変わらない限り一度だけ）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const themeVars = THEMES[settings.theme] ?? THEMES.dark;
    const isLight = settings.theme === 'light';

    const term = new Terminal({
      fontFamily: settings.editorFontFamily,
      fontSize: settings.terminalFontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: themeVars.bg,
        foreground: themeVars.text,
        cursor: themeVars.text,
        cursorAccent: themeVars.bg,
        selectionBackground: isLight ? '#add6ff' : '#264f78'
      },
      scrollback: 5000,
      convertEol: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // 画像 Blob を一時ファイルに保存し、パスを pty に挿入する共通処理
    const insertImageFromBlob = async (blob: Blob, mime: string): Promise<void> => {
      const buffer = await blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(i, i + chunkSize))
        );
      }
      const base64 = btoa(binary);

      const res = await window.api.terminal.savePastedImage(base64, mime);
      if (!res.ok || !res.path) {
        term.writeln(`\r\n\x1b[31m[画像保存失敗] ${res.error ?? '不明なエラー'}\x1b[0m`);
        return;
      }

      const p = res.path;
      const needQuote = /\s/.test(p);
      const inserted = (needQuote ? `"${p}"` : p) + ' ';

      if (ptyIdRef.current) {
        await window.api.terminal.write(ptyIdRef.current, inserted);
      }
    };

    // コピー＆ペーストのキーバインディング
    // - Ctrl+C: 選択中ならクリップボードへコピー、選択なしは通常通り pty へ送り SIGINT
    // - Ctrl+V / Ctrl+Shift+V: クリップボードから画像またはテキストをペースト
    // - Ctrl+Shift+C: 常にコピー（選択なしなら何もしない）
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();

      if (e.ctrlKey && !e.altKey && key === 'c') {
        const selection = term.getSelection();
        if (selection) {
          e.preventDefault();
          void navigator.clipboard.writeText(selection);
          term.clearSelection();
          return false;
        }
        return true;
      }

      if (e.ctrlKey && !e.altKey && key === 'v') {
        e.preventDefault();
        void (async () => {
          try {
            // clipboard.read() で画像を含む全アイテムを取得
            const clipboardItems = await navigator.clipboard.read();
            for (const item of clipboardItems) {
              for (const type of item.types) {
                if (type.startsWith('image/')) {
                  const blob = await item.getType(type);
                  await insertImageFromBlob(blob, type);
                  return;
                }
              }
            }
          } catch {
            // clipboard.read() 非対応やパーミッション拒否時はフォールスルー
          }
          // 画像なし → テキストペースト
          try {
            const text = await navigator.clipboard.readText();
            if (text) term.paste(text);
          } catch {
            /* noop */
          }
        })();
        return false;
      }

      return true;
    });

    termRef.current = term;
    fitRef.current = fit;

    // 初期サイズ調整
    let initialCols = 80;
    let initialRows = 24;
    try {
      fit.fit();
      initialCols = term.cols;
      initialRows = term.rows;
    } catch {
      /* 非表示マウント時は失敗してもOK */
    }

    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let offSessionId: (() => void) | null = null;
    let disposed = false;
    const cleanupTimers: ReturnType<typeof setTimeout>[] = [];

    (async () => {
      try {
        callbacksRef.current.onStatus?.(`${command} を起動中…`);
        // 初回 spawn 時点のスナップショットを使う（以後の prop 変化は無視）
        const snap = spawnPropsRef.current;
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

        if (disposed) return;

        if (!res.ok || !res.id) {
          term.writeln(`\x1b[31m[起動エラー] ${res.error ?? '不明なエラー'}\x1b[0m`);
          callbacksRef.current.onStatus?.(`起動失敗: ${res.error ?? ''}`);
          return;
        }

        ptyIdRef.current = res.id;
        callbacksRef.current.onStatus?.(`実行中: ${res.command ?? command}`);

        // ロールプロンプト等の初期メッセージ: CLIが入力待ちになってから順次送信
        const initMsg = snap.initialMessage;
        const msgQueue = initMsg
          ? Array.isArray(initMsg) ? [...initMsg] : [initMsg]
          : [];
        let msgIndex = 0;
        let sendCooldown = false;

        // セッション id は main プロセスが `~/.claude/projects/.../*.jsonl` の
        // 差分から検出し、`terminal:sessionId:<id>` で通知してくる。
        // URL 形式ではなく resume に使える UUID ファイル名を受け取れる。
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

          // キューにメッセージが残っていてCLIが入力待ち状態を検出
          if (msgIndex < msgQueue.length && ptyIdRef.current && !disposed && !sendCooldown) {
            const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
            // Claude Code: "? for shortcuts" 表示後にプロンプト準備完了
            // Codex: "❯" or "> " at line start
            const isReady = stripped.includes('? for shortcuts')
              || stripped.includes('❯')
              || /^\s*>\s*$/m.test(stripped);
            if (isReady) {
              sendCooldown = true;
              const msg = msgQueue[msgIndex++];
              const sendTimer = setTimeout(() => {
                if (ptyIdRef.current && !disposed) {
                  // 複数行は1行に整形して送信（ブラケットペーストは Claude Code で送信不可のため）
                  const flat = msg.replace(/\n{2,}/g, ' | ').replace(/\n/g, ' ');
                  void window.api.terminal.write(ptyIdRef.current, flat + '\r');
                }
                // 次のメッセージ送信まで少し待つ（CLIが処理完了するまで）
                const cooldownTimer = setTimeout(() => { sendCooldown = false; }, 3000);
                cleanupTimers.push(cooldownTimer);
              }, 500);
              cleanupTimers.push(sendTimer);
            }
          }
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

    // ---------- 画像ペーストフック（右クリックメニュー等のフォールバック） ----------
    const handlePaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;

      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) return;

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      void insertImageFromBlob(blob, imageItem.type).catch((err) => {
        term.writeln(`\r\n\x1b[31m[ペースト例外] ${String(err)}\x1b[0m`);
      });
    };

    // capture: true で xterm 内部の textarea より先にハンドリング
    const pasteTarget = term.element ?? container;
    pasteTarget.addEventListener('paste', handlePaste, true);

    // コンテナサイズ変化に追従。rAF スロットルでフレーム当たり1回だけ fit
    let resizePending = false;
    const ro = new ResizeObserver(() => {
      if (!visible) return;
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        try {
          fit.fit();
          if (ptyIdRef.current) {
            void window.api.terminal.resize(
              ptyIdRef.current,
              term.cols,
              term.rows
            );
          }
        } catch {
          /* 非表示状態などでの失敗は無視 */
        }
      });
    });
    ro.observe(container);

    return () => {
      disposed = true;
      cleanupTimers.forEach(clearTimeout);
      ro.disconnect();
      dataSub.dispose();
      offData?.();
      offExit?.();
      offSessionId?.();
      try {
        pasteTarget.removeEventListener('paste', handlePaste, true);
      } catch {
        /* noop */
      }
      if (ptyIdRef.current) {
        void window.api.terminal.kill(ptyIdRef.current);
        ptyIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // args / env / initialMessage などの再生成は snap ref 経由で無視する。
    // 並び替えや親コンポーネントの再レンダー経由で pty が巻き添え kill されるのを防ぐ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command]);

  // onSessionId / onStatus / onExit は ref 経由で参照しているので deps から除外

  // フォント・テーマ変更時は既存インスタンスに反映（ptyは再起動しない）
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;

    const themeVars = THEMES[settings.theme] ?? THEMES.dark;
    const isLight = settings.theme === 'light';

    term.options.fontFamily = settings.editorFontFamily;
    term.options.fontSize = settings.terminalFontSize;
    term.options.theme = {
      background: themeVars.bg,
      foreground: themeVars.text,
      cursor: themeVars.text,
      cursorAccent: themeVars.bg,
      selectionBackground: isLight ? '#add6ff' : '#264f78'
    };

    try {
      fit?.fit();
      if (ptyIdRef.current) {
        void window.api.terminal.resize(ptyIdRef.current, term.cols, term.rows);
      }
    } catch {
      /* noop */
    }
  }, [
    settings.theme,
    settings.editorFontFamily,
    settings.terminalFontSize
  ]);

  // 可視状態に切り替わったタイミングで再 fit
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term) return;
      try {
        fit.fit();
        if (ptyIdRef.current) {
          void window.api.terminal.resize(
            ptyIdRef.current,
            term.cols,
            term.rows
          );
        }
        term.focus();
      } catch {
        /* noop */
      }
    }, 30);
    return () => clearTimeout(t);
  }, [visible]);

    return <div className="terminal-view" ref={containerRef} />;
  }
);
