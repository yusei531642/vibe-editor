import type { AgentConfig, AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useNativeConfirm } from '../../lib/use-native-confirm';
import { parseShellArgsStrict } from '../../lib/parse-args';
import type { UpdateSetting } from './types';

interface Props {
  agent: AgentConfig;
  draft: AppSettings;
  update: UpdateSetting;
}

/**
 * カスタムエージェント 1 件のエディタ。
 * 名前・起動コマンド・引数・作業ディレクトリ・アクセントカラー を編集する。
 * 削除は SettingsModal 側のナビゲーション操作で行う。
 */
export function CustomAgentEditor({ agent, draft, update }: Props): JSX.Element {
  const t = useT();
  const confirm = useNativeConfirm();
  const argsParse = parseShellArgsStrict(agent.args);

  const patchAgent = (patch: Partial<AgentConfig>): void => {
    const next = (draft.customAgents ?? []).map((a) =>
      a.id === agent.id ? { ...a, ...patch } : a
    );
    update('customAgents', next);
  };

  const remove = async (): Promise<void> => {
    if (!(await confirm(t('settings.customAgents.confirmDelete', { name: agent.name })))) return;
    update(
      'customAgents',
      (draft.customAgents ?? []).filter((a) => a.id !== agent.id)
    );
  };

  return (
    <section className="modal__section">
      <div className="custom-agent__header">
        <h3>{agent.name || t('settings.customAgents.untitled')}</h3>
        <button type="button" className="toolbar__btn toolbar__btn--danger" onClick={remove}>
          {t('settings.customAgents.remove')}
        </button>
      </div>

      <label className="modal__label modal__label--full">
        <span>{t('settings.customAgents.name')}</span>
        <input
          type="text"
          value={agent.name}
          onChange={(e) => patchAgent({ name: e.target.value })}
          placeholder={t('settings.customAgents.namePlaceholder')}
          spellCheck={false}
        />
      </label>

      <label className="modal__label modal__label--full">
        <span>{t('settings.command')}</span>
        <input
          type="text"
          value={agent.command}
          onChange={(e) => patchAgent({ command: e.target.value })}
          placeholder="aider"
          spellCheck={false}
        />
      </label>

      <label className="modal__label modal__label--full">
        <span>{t('settings.customAgents.argsLabel')}</span>
        <input
          type="text"
          value={agent.args}
          onChange={(e) => patchAgent({ args: e.target.value })}
          placeholder='--model opus --yes'
          spellCheck={false}
          aria-invalid={argsParse.unterminatedQuote || argsParse.hasUnicodeDash}
        />
        {argsParse.unterminatedQuote && (
          <span className="modal__error">{t('settings.argsUnterminatedQuote')}</span>
        )}
        {argsParse.hasUnicodeDash && (
          <span className="modal__error">{t('settings.argsUnicodeDash')}</span>
        )}
      </label>

      <label className="modal__label modal__label--full">
        <span>{t('settings.customAgents.cwdLabel')}</span>
        <input
          type="text"
          value={agent.cwd ?? ''}
          onChange={(e) => patchAgent({ cwd: e.target.value })}
          placeholder={t('settings.customAgents.cwdUnset')}
          spellCheck={false}
        />
      </label>

      <label className="modal__label modal__label--full">
        <span>{t('settings.customAgents.accentColor')}</span>
        <input
          type="text"
          value={agent.color ?? ''}
          onChange={(e) => patchAgent({ color: e.target.value || undefined })}
          placeholder="#d97757"
          spellCheck={false}
        />
      </label>

      <p className="modal__note">{t('settings.customAgents.applyNote')}</p>
    </section>
  );
}
