import type { AgentConfig, AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
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
  const isJa = draft.language === 'ja';
  const argsParse = parseShellArgsStrict(agent.args);

  const patchAgent = (patch: Partial<AgentConfig>): void => {
    const next = (draft.customAgents ?? []).map((a) =>
      a.id === agent.id ? { ...a, ...patch } : a
    );
    update('customAgents', next);
  };

  const remove = async (): Promise<void> => {
    const { confirmAsync } = await import('../../lib/tauri-api');
    const ok = await confirmAsync(
      isJa
        ? `カスタムエージェント "${agent.name}" を削除しますか？`
        : `Delete custom agent "${agent.name}"?`
    );
    if (!ok) return;
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
          placeholder={isJa ? '例: Aider' : 'e.g. Aider'}
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
        <span>
          {isJa
            ? '引数（空白区切り、ダブルクォートで空白を含む値）'
            : 'Arguments (space-separated; use quotes for spaces)'}
        </span>
        <input
          type="text"
          value={agent.args}
          onChange={(e) => patchAgent({ args: e.target.value })}
          placeholder='--model opus --yes'
          spellCheck={false}
          aria-invalid={argsParse.unterminatedQuote}
        />
        {argsParse.unterminatedQuote && (
          <span className="modal__error">{t('settings.argsUnterminatedQuote')}</span>
        )}
      </label>

      <label className="modal__label modal__label--full">
        <span>
          {isJa
            ? '作業ディレクトリ（空なら現在のプロジェクトルート）'
            : 'Working directory (blank = current project root)'}
        </span>
        <input
          type="text"
          value={agent.cwd ?? ''}
          onChange={(e) => patchAgent({ cwd: e.target.value })}
          placeholder={isJa ? '（未設定）' : '(unset)'}
          spellCheck={false}
        />
      </label>

      <label className="modal__label modal__label--full">
        <span>{isJa ? 'アクセントカラー（任意）' : 'Accent color (optional)'}</span>
        <input
          type="text"
          value={agent.color ?? ''}
          onChange={(e) => patchAgent({ color: e.target.value || undefined })}
          placeholder="#d97757"
          spellCheck={false}
        />
      </label>

      <p className="modal__note">
        {isJa
          ? '変更後、Canvas で該当エージェントのカードを作り直すと反映されます。'
          : 'Recreate the agent card in Canvas to apply changes.'}
      </p>
    </section>
  );
}
