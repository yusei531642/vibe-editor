import { useEffect, useMemo, useState } from 'react';
import {
  API_AGENT_PROVIDER_PRESETS,
  type AgentConfig,
  type ApiAgentConfig,
  type ApiAgentProviderId,
  type AppSettings,
  type CliAgentConfig
} from '../../../../types/shared';
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
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const cliAgent = agent.runtime === 'cli' ? agent : null;
  const apiAgent = agent.runtime === 'api' ? agent : null;
  const argsParse = parseShellArgsStrict(cliAgent?.args ?? '');
  const provider = useMemo(
    () =>
      API_AGENT_PROVIDER_PRESETS.find((p) => p.id === apiAgent?.providerId) ??
      API_AGENT_PROVIDER_PRESETS[0],
    [apiAgent?.providerId]
  );

  const patchAgent = (patch: Partial<AgentConfig>): void => {
    const next = (draft.customAgents ?? []).map((a) =>
      a.id === agent.id ? { ...a, ...patch } : a
    ) as AgentConfig[];
    update('customAgents', next);
  };

  const replaceAgent = (nextAgent: AgentConfig): void => {
    update(
      'customAgents',
      (draft.customAgents ?? []).map((a) => (a.id === agent.id ? nextAgent : a))
    );
  };

  const remove = async (): Promise<void> => {
    if (!(await confirm(t('settings.customAgents.confirmDelete', { name: agent.name })))) return;
    update(
      'customAgents',
      (draft.customAgents ?? []).filter((a) => a.id !== agent.id)
    );
  };

  useEffect(() => {
    if (agent.runtime !== 'api') {
      setHasApiKey(null);
      return;
    }
    let disposed = false;
    void window.api.apiAgents
      .hasProviderKey(agent.providerId)
      .then((v) => {
        if (!disposed) setHasApiKey(v);
      })
      .catch(() => {
        if (!disposed) setHasApiKey(false);
      });
    return () => {
      disposed = true;
    };
  }, [agent]);

  const switchRuntime = (runtime: 'cli' | 'api'): void => {
    if (runtime === agent.runtime) return;
    if (runtime === 'cli') {
      replaceAgent({
        id: agent.id,
        name: agent.name,
        runtime: 'cli',
        command: '',
        args: '',
        cwd: '',
        color: agent.color
      } satisfies CliAgentConfig);
      return;
    }
    replaceAgent({
      id: agent.id,
      name: agent.name,
      runtime: 'api',
      providerId: 'openai',
      model: API_AGENT_PROVIDER_PRESETS[0].defaultModel,
      skillIds: [],
      toolMode: 'auto',
      color: agent.color
    } satisfies ApiAgentConfig);
  };

  const patchApiAgent = (patch: Partial<ApiAgentConfig>): void => {
    if (!apiAgent) return;
    patchAgent(patch as Partial<AgentConfig>);
  };

  const saveApiKey = async (): Promise<void> => {
    if (!apiAgent || !apiKeyDraft.trim()) return;
    await window.api.apiAgents.setProviderKey(apiAgent.providerId, apiKeyDraft);
    setApiKeyDraft('');
    setHasApiKey(true);
  };

  const clearApiKey = async (): Promise<void> => {
    if (!apiAgent) return;
    if (!(await confirm(t('settings.customAgents.apiKeyClearConfirm')))) return;
    await window.api.apiAgents.clearProviderKey(apiAgent.providerId);
    setHasApiKey(false);
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

      <div className="modal__label modal__label--full">
        <span>{t('settings.customAgents.runtime')}</span>
        <div className="segmented-control" role="tablist">
          <button
            type="button"
            className={agent.runtime === 'cli' ? 'is-active' : ''}
            onClick={() => switchRuntime('cli')}
          >
            CLI
          </button>
          <button
            type="button"
            className={agent.runtime === 'api' ? 'is-active' : ''}
            onClick={() => switchRuntime('api')}
          >
            API
          </button>
        </div>
      </div>

      {cliAgent && (
        <>
          <label className="modal__label modal__label--full">
            <span>{t('settings.command')}</span>
            <input
              type="text"
              value={cliAgent.command}
              onChange={(e) => patchAgent({ command: e.target.value })}
              placeholder="aider"
              spellCheck={false}
            />
          </label>

          <label className="modal__label modal__label--full">
            <span>{t('settings.customAgents.argsLabel')}</span>
            <input
              type="text"
              value={cliAgent.args}
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
              value={cliAgent.cwd ?? ''}
              onChange={(e) => patchAgent({ cwd: e.target.value })}
              placeholder={t('settings.customAgents.cwdUnset')}
              spellCheck={false}
            />
          </label>
        </>
      )}

      {apiAgent && (
        <>
          <label className="modal__label modal__label--full">
            <span>{t('settings.customAgents.provider')}</span>
            <select
              value={apiAgent.providerId}
              onChange={(e) => {
                const providerId = e.target.value as ApiAgentProviderId;
                const nextProvider = API_AGENT_PROVIDER_PRESETS.find((p) => p.id === providerId);
                patchApiAgent({
                  providerId,
                  model: nextProvider?.defaultModel ?? apiAgent.model,
                  customBaseUrl:
                    providerId === 'custom-openai-compatible'
                      ? apiAgent.customBaseUrl
                      : undefined
                });
              }}
            >
              {API_AGENT_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {apiAgent.providerId === 'custom-openai-compatible' && (
            <label className="modal__label modal__label--full">
              <span>{t('settings.customAgents.baseUrl')}</span>
              <input
                type="text"
                value={apiAgent.customBaseUrl ?? ''}
                onChange={(e) => patchApiAgent({ customBaseUrl: e.target.value })}
                placeholder="https://example.com/v1"
                spellCheck={false}
              />
            </label>
          )}

          <label className="modal__label modal__label--full">
            <span>{t('settings.customAgents.model')}</span>
            <input
              type="text"
              value={apiAgent.model}
              onChange={(e) => patchApiAgent({ model: e.target.value })}
              placeholder={provider.defaultModel || 'model-id'}
              spellCheck={false}
            />
          </label>

          <div className="modal__label modal__label--full">
            <span>{t('settings.customAgents.apiKey')}</span>
            <div className="custom-agent__key-row">
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                placeholder={hasApiKey ? t('settings.customAgents.apiKeySaved') : 'sk-...'}
                spellCheck={false}
              />
              <button type="button" className="toolbar__btn" onClick={saveApiKey}>
                {t('settings.voice.apiKey.save')}
              </button>
              <button type="button" className="toolbar__btn" onClick={clearApiKey}>
                {t('settings.voice.apiKey.clear')}
              </button>
            </div>
          </div>

          <label className="modal__label modal__label--full">
            <span>{t('settings.customAgents.toolMode')}</span>
            <select
              value={apiAgent.toolMode ?? (provider.supportsTools ? 'auto' : 'readOnly')}
              onChange={(e) => patchApiAgent({ toolMode: e.target.value as 'auto' | 'readOnly' })}
            >
              <option value="auto">{t('settings.customAgents.toolAuto')}</option>
              <option value="readOnly">{t('settings.customAgents.toolReadOnly')}</option>
            </select>
          </label>

          <label className="modal__label modal__label--full">
            <span>{t('settings.customAgents.systemPrompt')}</span>
            <textarea
              value={apiAgent.systemPrompt ?? ''}
              onChange={(e) => patchApiAgent({ systemPrompt: e.target.value })}
              rows={5}
              spellCheck={false}
            />
          </label>

          <p className="modal__note">
            {provider.supportsTools
              ? t('settings.customAgents.apiNote')
              : t('settings.customAgents.readOnlyNote')}
          </p>
        </>
      )}

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

      {cliAgent && <p className="modal__note">{t('settings.customAgents.applyNote')}</p>}
    </section>
  );
}
