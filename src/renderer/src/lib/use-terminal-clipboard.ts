import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { insertPastedImageToPty } from './paste-image-client';
import { translate } from './i18n';
import type { Language } from '../../../types/shared';

/**
 * ターミナルのコピー＆ペースト制御を担当するフック。
 *
 * 不変式 #4 (Ctrl+C の挙動):
 *   - 選択中 → クリップボードへコピーし `false` を返す (xterm に渡さない = SIGINT 送らない)
 *   - 非選択 → ハンドラは `true` を返し、xterm の既定経路で Ctrl+C が pty に送られる (= SIGINT)
 *
 * Ctrl+V / Ctrl+Shift+V:
 *   - クリップボードに画像があれば `insertPastedImageToPty` で一時ファイル保存 → パス挿入
 *   - 無ければテキストとして `term.paste()`
 *
 * 画像ペーストの DOM イベント (xterm 内 textarea での右クリック → 貼り付け等) も同じ経路で拾う。
 */
export function useTerminalClipboard(options: {
  termRef: MutableRefObject<Terminal | null>;
  containerRef: RefObject<HTMLDivElement>;
  /** 文字列を pty に書き込むコールバック (pty id が無ければ no-op) */
  writeToPty: (text: string) => void | Promise<void>;
  /** Issue #338: 言語の current を ref 経由で受け取る。
   *  内部 hook が React Context を直接引くと HMR で Context 分裂時にクラッシュ連鎖するため、
   *  caller 側で settings.language を ref に詰めて渡す。 */
  langRef: MutableRefObject<Language>;
}): void {
  const { termRef, containerRef, writeToPty, langRef } = options;

  const writeRef = useRef(writeToPty);
  writeRef.current = writeToPty;

  useEffect(() => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container) return;

    const writeError = (label: string, message: string): void => {
      term.writeln(`\r\n\x1b[31m[${label}] ${message}\x1b[0m`);
    };

    const handleImageBlob = async (blob: Blob, mime: string): Promise<void> => {
      const res = await insertPastedImageToPty(blob, mime, (text) => writeRef.current(text));
      if (!res.ok) {
        writeError(translate(langRef.current, 'terminal.pasteImageFailed'), res.error);
      }
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();

      if (e.ctrlKey && !e.altKey && key === 'c') {
        const selection = term.getSelection();
        if (selection) {
          // 不変式 #4: 選択時はコピー優先で xterm の既定処理を止める
          e.preventDefault();
          void navigator.clipboard.writeText(selection);
          term.clearSelection();
          return false;
        }
        // 不変式 #4: 非選択時は true を返し、xterm の既定経路 (= SIGINT) に任せる
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
                  await handleImageBlob(blob, type);
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

    // 画像ペーストフック (右クリックメニュー等のフォールバック)
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

      void handleImageBlob(blob, imageItem.type).catch((err) => {
        writeError(translate(langRef.current, 'terminal.pasteException'), String(err));
      });
    };

    // capture: true で xterm 内部の textarea より先にハンドリング
    const pasteTarget = term.element ?? container;
    pasteTarget.addEventListener('paste', handlePaste, true);

    return () => {
      try {
        pasteTarget.removeEventListener('paste', handlePaste, true);
      } catch {
        /* noop */
      }
    };
    // マウント時 1 回のみ。termRef / containerRef / writeToPty は ref 経由。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
