import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSettings } from '../lib/settings-context';
import { THEMES } from '../lib/themes';

interface TerminalViewProps {
  cwd: string;
  command: string;
  args?: string[];
  /** 現在このペインが表示されているか（非表示時は fit をスキップ） */
  visible: boolean;
  /** 起動中 / エラー表示用のコールバック */
  onStatus?: (status: string) => void;
  /** 出力イベント（非可視時のバッジ表示用） */
  onActivity?: () => void;
  /** プロセス終了通知 */
  onExit?: () => void;
}

/**
 * xterm.js + node-pty(IPC) でインタラクティブターミナルを描画する。
 * マウント時に一度だけ pty を起動し、アンマウント時に終了する。
 * タブ切替で display:none になっても DOM から外れなければ pty は生存する。
 */
export function TerminalView({
  cwd,
  command,
  args,
  visible,
  onStatus,
  onActivity,
  onExit
}: TerminalViewProps): JSX.Element {
  const { settings } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // コールバックは毎レンダーで新しい関数になるので ref で安定化
  const callbacksRef = useRef({ onStatus, onActivity, onExit });
  callbacksRef.current = { onStatus, onActivity, onExit };

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
      scrollback: 10000,
      convertEol: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

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
    let disposed = false;

    (async () => {
      try {
        callbacksRef.current.onStatus?.(`${command} を起動中…`);
        const res = await window.api.terminal.create({
          cwd,
          command,
          args,
          cols: initialCols,
          rows: initialRows
        });

        if (disposed) return;

        if (!res.ok || !res.id) {
          term.writeln(`\x1b[31m[起動エラー] ${res.error ?? '不明なエラー'}\x1b[0m`);
          callbacksRef.current.onStatus?.(`起動失敗: ${res.error ?? ''}`);
          return;
        }

        ptyIdRef.current = res.id;
        callbacksRef.current.onStatus?.(`実行中: ${res.command ?? command}`);

        offData = window.api.terminal.onData(res.id, (data) => {
          term.write(data);
          callbacksRef.current.onActivity?.();
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

    // ---------- 画像ペーストフック ----------
    // クリップボードに画像があれば一時ファイルに書き出して、パスを pty に流し込む
    const handlePaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // 画像アイテムを探す
      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) {
        // 画像なし → テキストペーストは xterm にそのまま任せる
        return;
      }

      // 画像あり: 既定のペースト（生のバイナリを textarea に投げ込み）を止める
      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;
      const mime = imageItem.type;

      (async () => {
        try {
          const buffer = await blob.arrayBuffer();
          // ArrayBuffer → base64
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

          // 空白を含むパスは " で囲む。末尾に空白を付けて次の入力と区切る
          const p = res.path;
          const needQuote = /\s/.test(p);
          const inserted = (needQuote ? `"${p}"` : p) + ' ';

          if (ptyIdRef.current) {
            await window.api.terminal.write(ptyIdRef.current, inserted);
          }
        } catch (err) {
          term.writeln(`\r\n\x1b[31m[ペースト例外] ${String(err)}\x1b[0m`);
        }
      })();
    };

    // capture: true で xterm 内部の textarea より先にハンドリング
    const pasteTarget = term.element ?? container;
    pasteTarget.addEventListener('paste', handlePaste, true);

    // コンテナサイズ変化に追従
    const ro = new ResizeObserver(() => {
      if (!visible) return;
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
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      offData?.();
      offExit?.();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command, (args ?? []).join(' ')]);

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
