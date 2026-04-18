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
// Issue #77: json / c / toml の contribution を追加登録。
//   - json: basic-languages にシンタックスのみ存在 (language worker は未登録)
//   - c: cpp の別エントリで、cpp.contribution には含まれないため明示
//   - toml: basic-languages には無いので、代替として ini を登録して TOML 拡張子も賄う
import 'monaco-editor/esm/vs/basic-languages/json/json.contribution';
import 'monaco-editor/esm/vs/basic-languages/c/c.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';

// 型: 環境変数は緩い any として扱う（Electron renderer だが self は Worker と共通の型がない）
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId: string, _label: string) {
    return new EditorWorker();
  }
};

// @monaco-editor/react に「ネットワークから取得せず、バンドル済みのmonacoを使え」と指示する
loader.config({ monaco });

// 初期化を確実に完了させる
export const monacoReady = loader.init();
