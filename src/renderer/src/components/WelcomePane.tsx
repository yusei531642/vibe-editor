interface WelcomePaneProps {
  projectName: string;
}

/**
 * メインエリアに diff タブが開かれていない時のプレースホルダ。
 * vibe coding 前提のため、エディタの代わりに案内のみを表示する。
 */
export function WelcomePane({ projectName }: WelcomePaneProps): JSX.Element {
  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">claude-editor</h1>
        <p className="welcome__subtitle">vibe coding with Claude Code</p>
        <p className="welcome__project">{projectName}</p>

        <ul className="welcome__hints">
          <li>
            <span className="welcome__hint-key">右</span>
            のターミナルで Claude Code に話しかける
          </li>
          <li>
            <span className="welcome__hint-key">変更</span>
            タブから Claude が触ったファイルの diff を確認
          </li>
          <li>
            <span className="welcome__hint-key">履歴</span>
            タブから過去のセッションに復帰
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> でコマンドパレット
          </li>
        </ul>
      </div>
    </div>
  );
}
