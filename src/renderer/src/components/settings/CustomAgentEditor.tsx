import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  API_AGENT_PROVIDER_PRESETS,
  type AgentConfig,
  type AgentEngine,
  type ApiAgentConfig,
  type ApiAgentProviderId,
  type ApiAgentSkillMeta,
  type AppSettings,
  type CliAgentConfig
} from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast-context';
import { SkillImportPanel } from './SkillImportPanel';
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
  const { showToast } = useToast();
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [availableSkills, setAvailableSkills] = useState<ApiAgentSkillMeta[]>([]);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const cliAgent = agent.runtime === 'cli' ? agent : null;
  const apiAgent = agent.runtime === 'api' ? agent : null;
  const apiProviderId = apiAgent?.providerId;
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
    if (!apiProviderId) {
      setHasApiKey(null);
      return;
    }
    setHasApiKey(null);
    let disposed = false;
    void window.api.apiAgents
      .hasProviderKey(apiProviderId)
      .then((v) => {
        if (!disposed) setHasApiKey(v);
      })
      .catch(() => {
        if (!disposed) setHasApiKey(false);
      });
    return () => {
      disposed = true;
    };
  }, [apiProviderId]);

  // provider / base URL が決まったら利用可能モデルを取得して datalist 候補にする。
  // 失敗 (鍵未設定 / ローカル未起動 等) は空のままで、従来どおり手入力できる。
  useEffect(() => {
    if (!apiProviderId) {
      setFetchedModels([]);
      return;
    }
    let disposed = false;
    void window.api.apiAgents
      .listModels(apiProviderId, apiAgent?.customBaseUrl || undefined)
      .then((list) => {
        if (!disposed) setFetchedModels(list);
      })
      .catch(() => {
        if (!disposed) setFetchedModels([]);
      });
    return () => {
      disposed = true;
    };
  }, [apiProviderId, apiAgent?.customBaseUrl]);

  // vibe-editor 専用フォルダの import 済み skill を列挙 (API runtime のときだけ)。
  const reloadSkills = useCallback((): void => {
    void window.api.apiAgents
      .listSkills()
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]));
  }, []);

  useEffect(() => {
    if (agent.runtime !== 'api') return;
    reloadSkills();
  }, [agent.runtime, reloadSkills]);

  const toggleSkill = (id: string): void => {
    if (!apiAgent) return;
    const current = apiAgent.skillIds ?? [];
    const next = current.includes(id)
      ? current.filter((s) => s !== id)
      : [...current, id];
    patchApiAgent({ skillIds: next });
  };

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
    try {
      // 失敗を握りつぶさず surface する。未署名 dev ビルドで macOS Keychain アクセスが
      // 拒否されると set_password が失敗するため、無言だと「保存できた」と誤認する (#1059)。
      await window.api.apiAgents.setProviderKey(apiAgent.providerId, apiKeyDraft);
      setApiKeyDraft('');
      setHasApiKey(true);
      showToast(t('voice.toast.apiKeySaved'), { tone: 'success' });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      showToast(t('settings.customAgents.apiKeySaveError', { detail }), {
        tone: 'error',
        duration: 8000
      });
    }
  };

  const clearApiKey = async (): Promise<void> => {
    if (!apiAgent) return;
    if (!(await confirm(t('settings.customAgents.apiKeyClearConfirm')))) return;
    try {
      await window.api.apiAgents.clearProviderKey(apiAgent.providerId);
      setHasApiKey(false);
      showToast(t('voice.toast.apiKeyCleared'), { tone: 'success' });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      showToast(t('settings.customAgents.apiKeySaveError', { detail }), {
        tone: 'error',
        duration: 8000
      });
    }
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

          <label className="modal__label modal__label--full">
            <span>{t('settings.customAgents.engine')}</span>
            <select
              value={cliAgent.engine ?? 'claude'}
              onChange={(e) => patchAgent({ engine: e.target.value as AgentEngine })}
            >
              <option value="claude">{t('settings.customAgents.engineClaude')}</option>
              <option value="codex">{t('settings.customAgents.engineCodex')}</option>
            </select>
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
                    providerId === 'custom-openai-compatible' || nextProvider?.local
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

          {(apiAgent.providerId === 'custom-openai-compatible' || provider.local) && (
            <label className="modal__label modal__label--full">
              <span>{t('settings.customAgents.baseUrl')}</span>
              <input
                type="text"
                value={apiAgent.customBaseUrl ?? ''}
                onChange={(e) => patchApiAgent({ customBaseUrl: e.target.value })}
                placeholder={provider.baseUrl ?? 'https://example.com/v1'}
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
              list={`agent-models-${agent.id}`}
            />
            {/* provider の /models から取得した候補 (取得失敗時は空 → 従来どおり手入力)。 */}
            <datalist id={`agent-models-${agent.id}`}>
              {fetchedModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
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

          <div className="modal__label modal__label--full">
            <span>{t('settings.customAgents.skills')}</span>
            {availableSkills.length === 0 ? (
              <p className="modal__note">{t('settings.customAgents.skillsEmpty')}</p>
            ) : (
              <div className="custom-agent__skills">
                {availableSkills.map((skill) => (
                  <label key={skill.id} className="custom-agent__skill" title={skill.description}>
                    <input
                      type="checkbox"
                      checked={(apiAgent.skillIds ?? []).includes(skill.id)}
                      onChange={() => toggleSkill(skill.id)}
                    />
                    <span className="custom-agent__skill-name">{skill.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="modal__note">{t('settings.customAgents.skillsAutoTeam')}</p>
            <SkillImportPanel onChanged={reloadSkills} />
          </div>

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

      <label className="modal__label modal__label--full">
        <span>{t('settings.customAgents.icon')}</span>
        <input
          type="text"
          value={agent.icon ?? ''}
          onChange={(e) => patchAgent({ icon: e.target.value || undefined })}
          placeholder="Terminal"
          spellCheck={false}
          list="custom-agent-icon-list"
        />
        <datalist id="custom-agent-icon-list">
          <option value="Sparkles" />
          <option value="Terminal" />
          <option value="Bot" />
          <option value="Boxes" />
          <option value="Cloud" />
          <option value="Cpu" />
          <option value="Rocket" />
          <option value="Wrench" />
        </datalist>
      </label>

      <label className="modal__label modal__label--full">
        <span>{t('settings.customAgents.tags')}</span>
        <input
          type="text"
          value={(agent.tags ?? []).join(', ')}
          onChange={(e) =>
            patchAgent({
              tags: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            })
          }
          placeholder={t('settings.customAgents.tagsPlaceholder')}
          spellCheck={false}
        />
      </label>

      {cliAgent && <p className="modal__note">{t('settings.customAgents.applyNote')}</p>}
    </section>
  );
}
