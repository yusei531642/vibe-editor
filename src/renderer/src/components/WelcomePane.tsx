import { useT } from '../lib/i18n';

interface WelcomePaneProps {
  projectName: string;
}

export function WelcomePane({ projectName }: WelcomePaneProps): JSX.Element {
  const t = useT();
  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">claude-editor</h1>
        <p className="welcome__subtitle">{t('welcome.subtitle')}</p>
        <p className="welcome__project">{projectName}</p>

        <ul className="welcome__hints">
          <li>
            <span className="welcome__hint-key">{t('welcome.hint1Key')}</span>
            {t('welcome.hint1Text')}
          </li>
          <li>
            <span className="welcome__hint-key">{t('welcome.hint2Key')}</span>
            {t('welcome.hint2Text')}
          </li>
          <li>
            <span className="welcome__hint-key">{t('welcome.hint3Key')}</span>
            {t('welcome.hint3Text')}
          </li>
          <li>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> {t('welcome.hint4Text')}
          </li>
        </ul>
      </div>
    </div>
  );
}
