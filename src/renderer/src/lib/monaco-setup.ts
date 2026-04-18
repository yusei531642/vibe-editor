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
 *   - 背景 = bg-1 (warm near-black #171716 / warm off-white #f8f8f6)
 *   - 前景 = text-1 (#f8f8f6 / #141413)
 *   - diff 配色は成功緑 / 危険赤を 10% tint で (bg 薄色、ガター記号は鮮色)
 *   - 他のトークン色は vs-dark / vs の安定色にフォールバック (上書き最小)
 */
monaco.editor.defineTheme('claude-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#171716',
    'editor.foreground': '#f8f8f6',
    'editor.lineHighlightBackground': '#1f1f1e',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#d97757',
    'editor.selectionBackground': '#2c2c2a',
    'editor.inactiveSelectionBackground': '#24241f',
    'editorLineNumber.foreground': '#6d6c66',
    'editorLineNumber.activeForeground': '#c3c2b7',
    'editorIndentGuide.background1': '#232321',
    'editorIndentGuide.activeBackground1': '#373734',
    // diff: 10% tint (skill セクション 6)
    'diffEditor.insertedTextBackground': '#578a0019',
    'diffEditor.removedTextBackground': '#cf3a3a19',
    'diffEditor.insertedLineBackground': '#578a000d',
    'diffEditor.removedLineBackground': '#cf3a3a0d',
    'diffEditorGutter.insertedLineBackground': '#578a0033',
    'diffEditorGutter.removedLineBackground': '#cf3a3a33',
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
    'editor.background': '#f8f8f6',
    'editor.foreground': '#141413',
    'editor.lineHighlightBackground': '#efeeeb',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#d97757',
    'editor.selectionBackground': '#e6e5e0',
    'editor.inactiveSelectionBackground': '#efeeeb',
    'editorLineNumber.foreground': '#b5b3ac',
    'editorLineNumber.activeForeground': '#373734',
    'editorIndentGuide.background1': '#ece9e2',
    'editorIndentGuide.activeBackground1': '#c3c2b7',
    'diffEditor.insertedTextBackground': '#578a0019',
    'diffEditor.removedTextBackground': '#cf3a3a19',
    'diffEditor.insertedLineBackground': '#578a000d',
    'diffEditor.removedLineBackground': '#cf3a3a0d',
    'diffEditorGutter.insertedLineBackground': '#578a0033',
    'diffEditorGutter.removedLineBackground': '#cf3a3a33'
  }
});

// 初期化を確実に完了させる
export const monacoReady = loader.init();
