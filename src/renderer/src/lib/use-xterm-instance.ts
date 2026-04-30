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

/*
 * Issue #272 v4: ホイール → scrollback の lines 換算で使う px-per-line。
 * Chromium 系で deltaMode=DOM_DELTA_PIXEL のとき、1 ノッチ ~100px 出る環境が多いので
 * 50 で割って 2 行/ノッチ程度に収める。DOM_DELTA_LINE/DOM_DELTA_PAGE はそれぞれ
 * 行/ページ単位なのでそのまま使う。
 */
const WHEEL_PIXEL_PER_LINE = 50;

function wheelEventToLineDelta(event: WheelEvent, rows: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * rows;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY;
  return event.deltaY / WHEEL_PIXEL_PER_LINE;
}

function shouldUseTransparentXtermBackground(theme: AppSettings['theme'], disableWebgl: boolean): boolean {
  // WebGL は Issue #333 回避のため透過必須。glass は DOM renderer でも透過を維持する。
  return !disableWebgl || theme === 'glass';
}

/*
 * Issue #126: Chromium の active WebGL context 上限は通常 16 (実装依存だが Tauri/WebView2
 * でも同等)。MAX_TERMINALS=30 のうち 16 個目以降の WebGL 作成が成功しても、新しい context
 * を作るたびに古い context が暗黙 lost され、ランダムに DOM renderer に降格する。
 * → 同時 active な WebGL は 8 までに制限し、それ以降は最初から DOM renderer で生成する。
 *   8 という値はリーダーボードで余裕を持たせた経験値 (Canvas モードで disableWebgl=true
 *   になる場合と合わせて、IDE モードでも 8 ターミナル分だけ GPU 加速を享受できる)。
 */
const MAX_ACTIVE_WEBGL = 8;
let activeWebglCount = 0;

/**
 * Box Drawing (U+2500-U+257F) / Block Elements (U+2580-U+259F) を確実に持つ
 * Windows OS フォント。ユーザー設定 fontFamily の末尾 (generic `monospace` の直前) に
 * 注入することで、Canvas モードの DOM renderer (customGlyphs が効かない経路) でも
 * 罫線/濃淡 glyph が必ずどれかから拾える状態を保証する。
 */
const BOX_DRAWING_FALLBACKS = [
  "'Cascadia Mono'",
  'Consolas',
  "'Lucida Console'",
  "'Segoe UI Symbol'"
] as const;

/**
 * ユーザー設定の fontFamily に、罫線/濃淡 glyph を確実に持つ Windows OS フォントを
 * fallback として注入する。
 *
 * 背景:
 *   Canvas モードの DOM renderer (TerminalCard / AgentNodeCard が disableWebgl=true)
 *   では xterm の customGlyphs が効かず、罫線/濃淡 glyph はフォントから取られる。
 *   bundled webfont (JetBrains Mono Variable / Geist Mono Variable) は @fontsource の
 *   subset 設計上 latin/cyrillic/greek 系のみで、Box Drawing (U+2500-U+257F) と Block
 *   Elements (U+2580-U+259F) を含まない。ユーザーの fallback chain にこれら glyph を持つ
 *   フォントが無い (古い preset を使ったまま等) と、Codex / Claude Code の box border が
 *   `|` `_` の混在で崩れて見える (Chromium の monospace 降格が MS Gothic 等を選ぶため)。
 *
 *   ここでユーザー設定の末尾に safety fallback を注入することで、設定値に依らず常に
 *   罫線が描けることを保証する。primary font は preserve するので、ユーザーが指定した
 *   見た目は変わらない (足りない glyph だけ fallback が拾う)。
 *   既に chain に含まれているフォントは重複追加しない (case-insensitive)。
 */
function ensureBoxDrawingFallbacks(family: string): string {
  const trimmed = family.trim().replace(/,\s*$/, '');
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  const missing = BOX_DRAWING_FALLBACKS.filter((fb) => {
    const name = fb.replace(/['"]/g, '').toLowerCase();
    return !lower.includes(name);
  });
  if (missing.length === 0) return family;
  // 末尾の generic `monospace` を見つけたらその直前に挿入。無ければ末尾追加 + monospace を補う。
  const m = trimmed.match(/^(.*?)(\s*,\s*monospace\s*)$/i);
  if (m) {
    return `${m[1]}, ${missing.join(', ')}${m[2]}`;
  }
  return `${trimmed}, ${missing.join(', ')}, monospace`;
}

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
  disableWebgl = false,
  forceWheelScrollback = false
): {
  containerRef: RefObject<HTMLDivElement>;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Issue #123: フォント変更後に WebGL のテクスチャアトラスを clear するため
  // webgl addon を effect 間で参照できるよう ref に保持する。
  const webglRef = useRef<WebglAddon | null>(null);

  // マウント時の初期値を ref に退避。初回 Terminal 生成に使う。
  // 以後のフォント/テーマ変化はリアクティブ effect 側で反映する。
  const initialSettingsRef = useRef(settings);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initial = initialSettingsRef.current;
    const term = new Terminal({
      // ターミナル専用フォントを優先、未設定なら editor フォントに fallback。
      // ensureBoxDrawingFallbacks: Canvas モードの DOM renderer で罫線/濃淡が崩れないよう
      // 設定値に Cascadia Mono / Consolas / Lucida Console / Segoe UI Symbol を必ず含める。
      fontFamily: ensureBoxDrawingFallbacks(initial.terminalFontFamily || initial.editorFontFamily),
      fontSize: initial.terminalFontSize,
      // 選択座標ズレ対策: lineHeight=1.2 × fontSize=13 → cellHeight=15.6 (非整数) だと
      // xterm v6 の selection 矩形計算で行方向にサブピクセル誤差が積もり、ドラッグ選択
      // した範囲が表示位置より数行下にずれることがある。lineHeight を 1.0 (default, 整数
      // cellHeight) に揃え、letterSpacing も明示してメトリックを安定させる。
      lineHeight: 1.0,
      letterSpacing: 0,
      cursorBlink: true,
      allowProposedApi: true,
      // glass テーマと WebGL 経路で xterm 背景を透過させるために必要 (Issue #89/#333)。
      // Canvas の DOM renderer では非 glass テーマのみ実背景色を渡し、文字色の同化を避ける (#343)。
      allowTransparency: true,
      // Block Elements (U+2580-U+259F) と Box Drawing (U+2500-U+257F) を
      // フォントから取らず WebGL/Canvas renderer 内蔵のベクター描画でラスタライズする。
      // Claude Code 起動時の Anthropic ロゴ ASCII art (▀▄█▌▐ 等) が、JetBrains Mono
      // Variable webfont の bundled subset にこれらを含まないことに起因して fallback
      // フォント次第で ▓ や □ (tofu) に化ける問題を防ぐ。xterm v6 default は true だが
      // 将来意図せず無効化されないよう明示する。DOM renderer では効かないので、
      // Canvas モード (disableWebgl=true) では font fallback 経由になる点に注意。
      customGlyphs: true,
      // CJK や全角記号など、セル幅を超える glyph をセル内に縮小して描画する。
      // ASCII art に CJK が混じった場合の桁ズレを防ぐ。
      rescaleOverlappingGlyphs: true,
      theme: buildXtermTheme(initial.theme, {
        transparentBackground: shouldUseTransparentXtermBackground(initial.theme, disableWebgl)
      }),
      scrollback: SCROLLBACK_LINES,
      convertEol: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    /*
     * Issue #272 v4: Canvas モード限定で「ホイール → scrollback スクロール」を強制する。
     *
     * 背景:
     *   xterm v6 は mouse protocol が wheel を要求 (Claude/Codex TUI が CoreMouseEventType.WHEEL
     *   を enable) すると Viewport の `handleMouseWheel` を false にして、wheel を
     *   CoreBrowserTerminal 側で app mouse wheel report として消費する。
     *   結果、Canvas のカード上でホイールを回しても scrollback が動かない。scrollbar drag は
     *   別経路 (DOM scrollbar.vertical) なので影響を受けない。
     *
     *   IDE モードでは scrollback を読みたいときも mouse mode を解除する習慣があるので
     *   既定挙動を維持する方が望ましい。Canvas モードでは「カードの中身を読み返す」用途が強いので
     *   wheel を scrollback に流すことを優先する。
     *
     * 仕様:
     *   - alt buffer (vim/less/htop など) では `return true` で xterm 既定動作 (TUI に通知)
     *   - Ctrl/Shift wheel は xterm 既定動作 (フォントサイズ変更など)
     *   - scrollback が 0 (baseY <= 0) なら xterm 既定動作
     *   - normal buffer + scrollback あり時のみ preventDefault + term.scrollLines() で末尾スクロール
     */
    if (forceWheelScrollback) {
      let wheelLineRemainder = 0;
      term.attachCustomWheelEventHandler((event) => {
        if (event.ctrlKey || event.shiftKey || event.deltaY === 0) return true;

        const activeBuffer = term.buffer.active;
        if (activeBuffer.type !== 'normal' || activeBuffer.baseY <= 0) {
          wheelLineRemainder = 0;
          return true;
        }

        wheelLineRemainder += wheelEventToLineDelta(event, term.rows);
        const lines = wheelLineRemainder > 0
          ? Math.floor(wheelLineRemainder)
          : Math.ceil(wheelLineRemainder);

        event.preventDefault();
        event.stopPropagation();

        if (lines !== 0) {
          wheelLineRemainder -= lines;
          term.scrollLines(lines);
        }
        return false;
      });
    }

    // WebGL レンダラ (主ケース): DOM renderer を GPU 描画に置き換え。
    // 環境 (headless / GPU 無効 / context lost) で失敗したら try/catch + webgl "contextlost"
    // イベントで dispose し、xterm が自動的に DOM renderer へフォールバックする。
    //
    // disableWebgl=true (Canvas モード) の場合は WebGL を読み込まず DOM renderer のままにする。
    // 親の `transform: scale(zoom)` で WebGL canvas が GPU 補間されると滲むため。
    let webglOwned = false;
    if (!disableWebgl && activeWebglCount < MAX_ACTIVE_WEBGL) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (webglOwned) {
            webglOwned = false;
            activeWebglCount = Math.max(0, activeWebglCount - 1);
          }
          webglRef.current = null;
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
        webglOwned = true;
        activeWebglCount += 1;
      } catch (err) {
        // 例: WebGL 作成不可 → DOM renderer で続行 (問題なく動作する)
        console.warn('[xterm] WebGL addon 初期化失敗 → DOM renderer にフォールバック:', err);
        webglRef.current = null;
      }
    }

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      webglRef.current?.dispose();
      webglRef.current = null;
      if (webglOwned) {
        webglOwned = false;
        activeWebglCount = Math.max(0, activeWebglCount - 1);
      }
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
    term.options.fontFamily = ensureBoxDrawingFallbacks(
      settings.terminalFontFamily || settings.editorFontFamily
    );
    term.options.fontSize = settings.terminalFontSize;
    term.options.theme = buildXtermTheme(settings.theme, {
      transparentBackground: shouldUseTransparentXtermBackground(settings.theme, disableWebgl)
    });
    // Issue #123: WebGL renderer はグリフをテクスチャアトラスにキャッシュするため、
    // fontFamily/fontSize を切り替えても古いフォントの glyph が描画され続けることがある。
    // clearTextureAtlas() で強制的にアトラスを破棄して新フォントで再ラスタライズさせる。
    try {
      webglRef.current?.clearTextureAtlas();
    } catch {
      // dispose 直後など WebGL コンテキストが既に失われている場合は無視
    }
    // Issue #113: フォント変更後に fit を呼ばないと xterm 内部の cols/rows と
    // コンテナの実 px サイズの整合が取れず、グリフキャッシュが古いセル幅のまま残って
    // 文字が滲んだり位置が崩れる。requestAnimationFrame で次の paint 後に再計測する。
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        // Issue #123: fit() が cols/rows を変えなかった場合、内部的に refresh が走らず
        // 既に描画済みの行が古いフォント glyph のまま残ることがある。明示的に全行 refresh する。
        termRef.current?.refresh(0, (termRef.current.rows ?? 1) - 1);
      } catch {
        // fit は container 不在 / Terminal dispose 直後で例外を投げ得る (無視で安全)
      }
    });
  }, [
    settings.theme,
    settings.terminalFontFamily,
    settings.editorFontFamily,
    settings.terminalFontSize,
    disableWebgl
  ]);

  return { containerRef, termRef, fitRef };
}
