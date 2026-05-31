/**
 * 型宣言を同梱しない 3rd-party の side-effect import 用 ambient 宣言。
 *
 * TypeScript 6 / `moduleResolution: bundler` では型宣言の無いモジュールを
 * side-effect import (`import 'foo';`) すると TS2882 になる。実体は Vite が
 * バンドル時に解決する CSS / monaco contribution であり、TS としては値も型も
 * 持たない空モジュールとして宣言しておけば十分。
 *
 * - monaco-editor の basic-languages 各 `*.contribution` (構文ハイライト登録)
 * - @fontsource-variable/* (可変フォントの @font-face CSS)
 */
declare module 'monaco-editor/esm/vs/basic-languages/*';
declare module '@fontsource-variable/*';

/**
 * monaco-editor の selective import entry。`package.json` の `exports` が
 * `"./*": "./*"` で型なしのファイルパスへ直結するため、TS6 / bundler 解決では
 * 同梱の `editor.api.d.ts` を辿れず TS2307 になる。実体の型は package root
 * (`monaco-editor` = `editor.main.d.ts`) と同一 API surface なので、ここで
 * root の型を re-export して selective import 経路にも型を供給する。
 */
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor';
}
