import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { AppSettings } from '../../../types/shared';
import { buildXtermTheme } from './xterm-theme';

/*
 * 多数ターミナル同時起動の軽量化 (30 本以上想定):
 *   - Scrollback を 5000 → 2000 行に縮小。30 本 × 5000 = 150k 行相当の DOM を抱えていた
 *   - WebGL レンダラを loadAddon。DOM renderer の 3-5 倍速く、GPU で描画するので
 *     メインスレッドを奪わない → 多数インスタンス同時で "めちゃくちゃ重い" を解消する。
 *   - WebGL コンテキストが作れない環境 (GPU なし / 古い WebView2) では自動で
 *     デフォルトの DOM renderer にフォールバックする。Tauri の WebView2 (Chromium 系)
 *     は通常 WebGL2 が使えるので基本は WebGL 経路で動作する。
 */
const SCROLLBACK_LINES = 2000;

/**
 * xterm.js `Terminal` インスタンスと `FitAddon` をマウント中 1 回だけ生成し、
 * フォント/テーマの変更を反映させるフック。
 *
 * pty のライフサイクルとは独立で、cwd/command の変化では作り直さない。
 * コンテナ DOM は `containerRef` を div にアタッチして利用する。
 *
 * @param disableWebgl true なら WebglAddon を読み込まず、xterm v6 デフォルトの DOM renderer
 *   を使う。Canvas モードでは React Flow が親に `transform: scale(zoom)` を当てるため
 *   WebGL canvas の bitmap がアップサンプリングされて滲む。DOM renderer なら text は実 DOM
 *   なので Chromium が親 transform に応じて再ラスタライズし、常にシャープに描画される。
 */
export function useXtermInstance(
  settings: AppSettings,
  disableWebgl = false
): {
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
      // ターミナル専用フォントを優先、未設定なら editor フォントに fallback
      fontFamily: initial.terminalFontFamily || initial.editorFontFamily,
      fontSize: initial.terminalFontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      // glass テーマで xterm キャンバスを透過させるために必要 (Issue #89)。
      // 他テーマでも不透明色を渡しているので挙動は変わらない。
      allowTransparency: true,
      theme: buildXtermTheme(initial.theme),
      scrollback: SCROLLBACK_LINES,
      convertEol: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // WebGL レンダラ (主ケース): DOM renderer を GPU 描画に置き換え。
    // 環境 (headless / GPU 無効 / context lost) で失敗したら try/catch + webgl "contextlost"
    // イベントで dispose し、xterm が自動的に DOM renderer へフォールバックする。
    //
    // disableWebgl=true (Canvas モード) の場合は WebGL を読み込まず DOM renderer のままにする。
    // 親の `transform: scale(zoom)` で WebGL canvas が GPU 補間されると滲むため。
    let webgl: WebglAddon | null = null;
    if (!disableWebgl) {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
        });
        term.loadAddon(webgl);
      } catch (err) {
        // 例: WebGL 作成不可 → DOM renderer で続行 (問題なく動作する)
        console.warn('[xterm] WebGL addon 初期化失敗 → DOM renderer にフォールバック:', err);
        webgl = null;
      }
    }

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      webgl?.dispose();
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
    term.options.fontFamily = settings.terminalFontFamily || settings.editorFontFamily;
    term.options.fontSize = settings.terminalFontSize;
    term.options.theme = buildXtermTheme(settings.theme);
  }, [settings.theme, settings.terminalFontFamily, settings.editorFontFamily, settings.terminalFontSize]);

  return { containerRef, termRef, fitRef };
}
