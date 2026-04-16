import { useMemo } from 'react';
import { useT } from '../lib/i18n';
import { useSettings } from '../lib/settings-context';

interface WelcomePaneProps {
  projectName: string;
}

export function WelcomePane({ projectName }: WelcomePaneProps): JSX.Element {
  const t = useT();
  const { settings } = useSettings();
  const recentProjects = useMemo(
    () =>
      (settings.recentProjects ?? [])
        .filter((path, index, list) => list.indexOf(path) === index)
        .slice(0, 4),
    [settings.recentProjects]
  );
  const isJa = settings.language === 'ja';
  const hintCards = useMemo(
    () => [
      { key: 'hint-right', title: t('welcome.hint1Key'), text: t('welcome.hint1Text') },
      { key: 'hint-changes', title: t('welcome.hint2Key'), text: t('welcome.hint2Text') },
      { key: 'hint-history', title: t('welcome.hint3Key'), text: t('welcome.hint3Text') },
      { key: 'hint-palette', title: 'Ctrl + Shift + P', text: t('welcome.hint4Text') }
    ],
    [t]
  );

  const shortName = (path: string): string => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || path;
  };

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <div className="welcome__hero">
          <span className="welcome__eyebrow">vibe-editor</span>
          <h1 className="welcome__title">
            {isJa ? '静かな集中で、すばやく進める。' : 'Build with calm momentum.'}
          </h1>
          <p className="welcome__subtitle">{t('welcome.subtitle')}</p>
          <div className="welcome__project-pill">{projectName}</div>
        </div>

        <div className="welcome__grid">
          <section className="welcome__section">
            <div className="welcome__section-head">
              <div>
                <p className="welcome__section-label">
                  {isJa ? '最近のプロジェクト' : 'Recent projects'}
                </p>
                <h2 className="welcome__section-title">
                  {isJa ? 'すぐに戻れる作業面' : 'Jump back into your flow'}
                </h2>
              </div>
              <span className="welcome__section-meta">
                {Math.max(recentProjects.length, 1)}
              </span>
            </div>
            <div className="welcome__cards">
              {(recentProjects.length > 0 ? recentProjects : [projectName]).map((path) => (
                <article key={path} className="welcome__card">
                  <span className="welcome__card-label">
                    {isJa ? 'ワークスペース' : 'Workspace'}
                  </span>
                  <strong className="welcome__card-title">{shortName(path)}</strong>
                  <p className="welcome__card-subtitle">{path}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="welcome__section welcome__section--tips">
            <div className="welcome__section-head">
              <div>
                <p className="welcome__section-label">
                  {isJa ? 'クイックスタート' : 'Quick start'}
                </p>
                <h2 className="welcome__section-title">
                  {isJa ? 'よく使う操作' : 'What you can do next'}
                </h2>
              </div>
            </div>
            <div className="welcome__cards welcome__cards--tips">
              {hintCards.map((item) => (
                <article key={item.key} className="welcome__card welcome__card--tip">
                  <span className="welcome__hint-key">{item.title}</span>
                  <p className="welcome__card-subtitle">{item.text}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
