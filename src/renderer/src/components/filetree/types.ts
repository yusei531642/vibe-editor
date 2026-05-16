export type InlineInputState = {
  rootPath: string;
  /** 入力 row を表示する親ディレクトリの相対パス。'' でルート直下。 */
  parentRel: string;
  mode: 'create-file' | 'create-folder' | 'rename';
  /** rename のときの旧 basename。create のときは空文字。 */
  initialName: string;
  /** rename のときの旧相対パス。create のときは undefined。 */
  originalRelPath?: string;
};
