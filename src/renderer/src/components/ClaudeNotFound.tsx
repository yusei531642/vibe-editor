import { AlertTriangle, ExternalLink, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { useT } from '../lib/i18n';

interface ClaudeNotFoundProps {
  error?: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}

/**
 * `claude` コマンドが PATH に見つからない時に Claude Code パネル内に表示するエラービュー。
 * vibe coding の前提が壊れている状態なので、ユーザーに明確なアクションを提示する。
 */
export function ClaudeNotFound({
  error,
  onRetry,
  onOpenSettings
}: ClaudeNotFoundProps): JSX.Element {
  const t = useT();
  return (
    <div className="claude-not-found">
      <div className="claude-not-found__panel">
        <div className="claude-not-found__icon">
          <AlertTriangle size={40} strokeWidth={1.5} />
        </div>
        <span className="claude-not-found__eyebrow">Claude Code</span>
        <h2 className="claude-not-found__title">{t('claudePanel.notFound.title')}</h2>
        <p className="claude-not-found__body">{t('claudePanel.notFound.body')}</p>
        {error && <p className="claude-not-found__detail">{error}</p>}

        <div className="claude-not-found__steps">
          <div className="claude-not-found__step">
            <span className="claude-not-found__step-index">1</span>
            <div>
              <strong>{t('claudePanel.notFound.step1Title')}</strong>
              <p>{t('claudePanel.notFound.step1Desc')}</p>
            </div>
          </div>
          <div className="claude-not-found__step">
            <span className="claude-not-found__step-index">2</span>
            <div>
              <strong>{t('claudePanel.notFound.step2Title')}</strong>
              <p>{t('claudePanel.notFound.step2Desc')}</p>
            </div>
          </div>
        </div>

        <div className="claude-not-found__actions">
          <button
            type="button"
            className="toolbar__btn toolbar__btn--primary"
            onClick={onRetry}
          >
            <RotateCw size={14} strokeWidth={2} />
            <span>{t('claudePanel.notFound.retry')}</span>
          </button>
          <button type="button" className="toolbar__btn" onClick={onOpenSettings}>
            <SettingsIcon size={14} strokeWidth={1.75} />
            <span>{t('claudePanel.notFound.settings')}</span>
          </button>
        </div>

        <a
          className="claude-not-found__install"
          href="https://claude.com/code"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={12} strokeWidth={2} />
          <span>{t('claudePanel.notFound.installLink')}</span>
        </a>
      </div>
    </div>
  );
}
