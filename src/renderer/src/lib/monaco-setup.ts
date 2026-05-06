// Monaco Editor を selective import し、使用する言語のみを登録する。
// 全言語 entry (`monaco-editor`) を import すると 80+ 言語と language worker が
// バンドルに含まれて肥大化するため、editor.api + basic-languages の個別 contribution
// のみを読み込む。language worker (ts/css/html/json) は登録しないので
// editor.worker だけで動作する。

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { loader } from '@monaco-editor/react';
// @ts-expect-error ?worker import は Vite 固有
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// basic-languages: 軽量シンタックスハイライトのみ (language worker なし)
// language.ts の EXT_MAP に対応する 27 言語を登録する。
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution';
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
// Issue #77: toml は basic-languages に無いので ini で代替。
// json と c は monaco-editor v0.55 の basic-languages に entry が無い
// (json は language/json の worker 同梱版のみ、c は cpp に統合済み)。
// 軽量重視のためここでは登録しない — 必要なら language/json + worker 設定で別途。
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';

// 型: 環境変数は緩い any として扱う（Electron renderer だが self は Worker と共通の型がない）
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId: string, _label: string) {
    return new EditorWorker();
  }
};

// @monaco-editor/react に「ネットワークから取得せず、バンドル済みのmonacoを使え」と指示する
loader.config({ monaco });

/*
 * Claude 公式風カスタムテーマ (skill: claude-design 準拠)
 *
 *   - 背景 = bg-1 (warm near-black / warm off-white)
 *   - 前景 = text-1 (高コントラスト)
 *   - diff 配色は成功緑 / 危険赤を 10% tint で (bg 薄色、ガター記号は鮮色)
 *   - 他のトークン色は vs-dark / vs の安定色にフォールバック (上書き最小)
 *
 * 色値は **`styles/tokens.css` の `[data-theme='claude-{dark,light}']` ブロックを唯一の
 * source of truth** とし、ここでは `getComputedStyle` でその CSS 変数を読み出してから
 * `defineTheme` に流し込む。旧実装は同じ hex を `themes.ts` / `tokens.css` /
 * `monaco-setup.ts` の 3 箇所に書いており、片方を直し忘れて Monaco 単独が古い色のまま
 * になる事故が起きやすかった (Issue #490)。
 */

/** ブラウザ非依存の安全な hex 色。`getComputedStyle` が空文字 (= まだ CSS が未適用)
 *  を返したときの fallback。値は tokens.css claude-dark の代表色を引用。 */
const MONACO_FALLBACK = {
  cdBg: '#171716',
  cdPanel: '#1f1f1e',
  cdElev: '#2c2c2a',
  cdText: '#f8f8f6',
  cdTextDim: '#c3c2b7',
  cdAccent: '#d97757',
  clBg: '#f8f8f6',
  clPanel: '#efeeeb',
  clText: '#141413',
  clTextDim: '#373734'
} as const;

function readVar(probe: HTMLElement, name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(probe).getPropertyValue(name).trim();
  return v || fallback;
}

interface ProbeColors {
  bg: string;
  panel: string;
  elev: string;
  text: string;
  textDim: string;
  accent: string;
}

function probeThemeColors(themeName: 'claude-dark' | 'claude-light', fb: ProbeColors): ProbeColors {
  if (typeof document === 'undefined' || !document.body) {
    return fb;
  }
  // tokens.css の `[data-theme='X']` blocks に hit させるための一時要素。
  // display:none で renderer に表示はしないが、getComputedStyle は data-theme の
  // cascade を尊重して resolve した値を返してくれる。
  const el = document.createElement('div');
  el.setAttribute('data-theme', themeName);
  el.style.display = 'none';
  document.body.appendChild(el);
  try {
    return {
      bg: readVar(el, '--bg', fb.bg),
      panel: readVar(el, '--bg-panel', fb.panel),
      elev: readVar(el, '--bg-elev', fb.elev),
      text: readVar(el, '--text', fb.text),
      textDim: readVar(el, '--text-dim', fb.textDim),
      accent: readVar(el, '--accent', fb.accent)
    };
  } finally {
    el.remove();
  }
}

/**
 * Claude diff エディタのインク (10% tint)。
 * tokens.css の `--claude-success` / `--claude-danger` を直接 hex8 に展開する。
 * Monaco は alpha 付き hex (`#RRGGBBAA`) を受け付けるため固定で OK。
 *
 * 色値自体は tokens.css と完全一致 (`#578a00` / `#cf3a3a`)。
 */
const DIFF_TINTS = {
  insertedText: '#578a0019',
  removedText: '#cf3a3a19',
  insertedLine: '#578a000d',
  removedLine: '#cf3a3a0d',
  insertedGutter: '#578a0033',
  removedGutter: '#cf3a3a33'
} as const;

function defineMonacoThemes(): void {
  const cd = probeThemeColors('claude-dark', {
    bg: MONACO_FALLBACK.cdBg,
    panel: MONACO_FALLBACK.cdPanel,
    elev: MONACO_FALLBACK.cdElev,
    text: MONACO_FALLBACK.cdText,
    textDim: MONACO_FALLBACK.cdTextDim,
    accent: MONACO_FALLBACK.cdAccent
  });
  const cl = probeThemeColors('claude-light', {
    bg: MONACO_FALLBACK.clBg,
    panel: MONACO_FALLBACK.clPanel,
    elev: MONACO_FALLBACK.clPanel,
    text: MONACO_FALLBACK.clText,
    textDim: MONACO_FALLBACK.clTextDim,
    accent: MONACO_FALLBACK.cdAccent
  });

  monaco.editor.defineTheme('claude-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cd.bg,
      'editor.foreground': cd.text,
      'editor.lineHighlightBackground': cd.panel,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': cd.accent,
      'editor.selectionBackground': cd.elev,
      'editor.inactiveSelectionBackground': '#24241f',
      'editorLineNumber.foreground': '#6d6c66',
      'editorLineNumber.activeForeground': cd.textDim,
      'editorIndentGuide.background1': '#232321',
      'editorIndentGuide.activeBackground1': '#373734',
      'diffEditor.insertedTextBackground': DIFF_TINTS.insertedText,
      'diffEditor.removedTextBackground': DIFF_TINTS.removedText,
      'diffEditor.insertedLineBackground': DIFF_TINTS.insertedLine,
      'diffEditor.removedLineBackground': DIFF_TINTS.removedLine,
      'diffEditorGutter.insertedLineBackground': DIFF_TINTS.insertedGutter,
      'diffEditorGutter.removedLineBackground': DIFF_TINTS.removedGutter,
      'scrollbarSlider.background': '#2c2c2a80',
      'scrollbarSlider.hoverBackground': '#373734a0',
      'scrollbarSlider.activeBackground': '#373734cc'
    }
  });

  monaco.editor.defineTheme('claude-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cl.bg,
      'editor.foreground': cl.text,
      'editor.lineHighlightBackground': cl.panel,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': cl.accent,
      'editor.selectionBackground': '#e6e5e0',
      'editor.inactiveSelectionBackground': cl.panel,
      'editorLineNumber.foreground': '#b5b3ac',
      'editorLineNumber.activeForeground': cl.textDim,
      'editorIndentGuide.background1': '#ece9e2',
      'editorIndentGuide.activeBackground1': '#c3c2b7',
      'diffEditor.insertedTextBackground': DIFF_TINTS.insertedText,
      'diffEditor.removedTextBackground': DIFF_TINTS.removedText,
      'diffEditor.insertedLineBackground': DIFF_TINTS.insertedLine,
      'diffEditor.removedLineBackground': DIFF_TINTS.removedLine,
      'diffEditorGutter.insertedLineBackground': DIFF_TINTS.insertedGutter,
      'diffEditorGutter.removedLineBackground': DIFF_TINTS.removedGutter
    }
  });
}

defineMonacoThemes();

// 初期化を確実に完了させる
export const monacoReady = loader.init();
