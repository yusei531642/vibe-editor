declare module '@fontsource-variable/inter';
declare module '@fontsource-variable/geist';
declare module '@fontsource-variable/source-serif-4';
declare module '@fontsource-variable/jetbrains-mono';
declare module '@fontsource-variable/geist-mono';

declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/less/less.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}
