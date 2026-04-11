// Monaco Editor を npm パッケージから使うための worker セットアップ。
// Vite の ?worker import を使ってエディタワーカーをバンドルに含める。
// Markdown は language worker を必要としないため editor.worker のみで十分。

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
// @ts-expect-error ?worker import は Vite 固有
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

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
