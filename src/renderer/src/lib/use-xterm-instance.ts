import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AppSettings } from '../../../types/shared';
import { buildXtermTheme } from './xterm-theme';

/**
 * xterm.js `Terminal` インスタンスと `FitAddon` をマウント中 1 回だけ生成し、
 * フォント/テーマの変更を反映させるフック。
 *
 * pty のライフサイクルとは独立で、cwd/command の変化では作り直さない。
 * コンテナ DOM は `containerRef` を div にアタッチして利用する。
 */
export function useXtermInstance(settings: AppSettings): {
  containerRef: RefObject<HTMLDivElement>;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // マウント時の初期値を ref に退避。初回 Terminal 生成に使う。
  // 以後のフォント/テーマ変化はリアクティブ effect 側で反映する。
  const initialSettingsRef = useRef(settings);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initial = initialSettingsRef.current;
    const term = new Terminal({
      fontFamily: initial.editorFontFamily,
      fontSize: initial.terminalFontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: buildXtermTheme(initial.theme),
      scrollback: 5000,
      convertEol: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // マウント時 1 回のみ。settings は ref 経由で初期値を参照する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // フォント・テーマ変更を既存 Terminal に反映（再生成しない）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.editorFontFamily;
    term.options.fontSize = settings.terminalFontSize;
    term.options.theme = buildXtermTheme(settings.theme);
  }, [settings.theme, settings.editorFontFamily, settings.terminalFontSize]);

  return { containerRef, termRef, fitRef };
}
