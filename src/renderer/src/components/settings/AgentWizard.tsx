/**
 * AgentWizard — 新規エージェント追加ウィザード (Issue #1123)。
 *
 * 生フィールド直打ちだった追加導線を、ステップ式の案内に置き換える (設定モーダルから起動)。
 *   Step1 種別   : API モデル (メイン・案内付き) / CLI コマンド
 *   Step2 設定   : API → provider/model/APIキー(任意) ／ CLI → command/args/engine
 *   Step3 見た目 : name / icon / accent color / tags
 *   Step4 確認   : サマリ → customAgents へ追加
 *
 * 完成した AgentConfig は `onCreate` で親 (SettingsModal) に渡し、customAgents へ append する。
 * 表示は自己完結した `agent-wizard.css` を使い、入力欄は共通の `modal__*` クラスを流用する。
 */
import { useMemo, useState } from 'react';
import {
  API_AGENT_PROVIDER_PRESETS,
  type AgentConfig,
  type AgentEngine,
  type ApiAgentProviderId
} from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast-context';

interface Props {
  /** 作成した agent を customAgents に追加する。 */
  onCreate: (agent: AgentConfig) => void;
  onCancel: () => void;
}

type Runtime = 'api' | 'cli';
type StepId = 'type' | 'configure' | 'appearance' | 'review';
const STEPS: StepId[] = ['type', 'configure', 'appearance', 'review'];

const ICON_SUGGESTIONS = ['Sparkles', 'Terminal', 'Bot', 'Boxes', 'Cloud', 'Cpu', 'Rocket', 'Wrench'];

function makeId(): string {
  return `ca_${Math.random().toString(36).slice(2, 10)}`;
}

export function AgentWizard({ onCreate, onCancel }: Props): JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const [stepIdx, setStepIdx] = useState(0);
  const [runtime, setRuntime] = useState<Runtime>('api');
  const [name, setName] = useState('');
  // CLI
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [engine, setEngine] = useState<AgentEngine>('claude');
  // API
  const [providerId, setProviderId] = useState<ApiAgentProviderId>(
    API_AGENT_PROVIDER_PRESETS[0].id
  );
  const [model, setModel] = useState(API_AGENT_PROVIDER_PRESETS[0].defaultModel);
  const [apiKey, setApiKey] = useState('');
  // appearance
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');

  const step = STEPS[stepIdx];
  const provider = useMemo(
    () =>
      API_AGENT_PROVIDER_PRESETS.find((p) => p.id === providerId) ??
      API_AGENT_PROVIDER_PRESETS[0],
    [providerId]
  );

  const canNext = useMemo(() => {
    if (step === 'configure') {
      return runtime === 'api' ? model.trim().length > 0 : command.trim().length > 0;
    }
    if (step === 'appearance') return name.trim().length > 0;
    return true;
  }, [step, runtime, model, command, name]);

  const goNext = (): void => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  const goPrev = (): void => setStepIdx((i) => Math.max(i - 1, 0));

  const onPickProvider = (id: ApiAgentProviderId): void => {
    setProviderId(id);
    const p = API_AGENT_PROVIDER_PRESETS.find((x) => x.id === id);
    if (p) setModel(p.defaultModel);
  };

  const buildAgent = (): AgentConfig => {
    const id = makeId();
    const tags = tagsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const base = {
      id,
      name: name.trim() || id,
      color: color.trim() || undefined,
      icon: icon.trim() || undefined,
      tags: tags.length ? tags : undefined
    };
    if (runtime === 'api') {
      return {
        ...base,
        runtime: 'api',
        providerId,
        model: model.trim(),
        toolMode: provider.supportsTools ? 'auto' : 'readOnly'
      };
    }
    return { ...base, runtime: 'cli', command: command.trim(), args: args.trim(), cwd: '', engine };
  };

  const handleCreate = async (): Promise<void> => {
    const agent = buildAgent();
    // API キーは best-effort 保存 (失敗してもエージェントは作成し、後で設定で入力できる)。
    if (agent.runtime === 'api' && apiKey.trim()) {
      try {
        await window.api.apiAgents.setProviderKey(agent.providerId, apiKey.trim());
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(t('settings.customAgents.apiKeySaveError', { detail }), {
          tone: 'warning',
          duration: 6000
        });
      }
    }
    onCreate(agent);
  };

  return (
    <div className="agent-wizard" role="dialog" aria-modal="true" aria-label={t('settings.agentWizard.title')}>
      <div className="agent-wizard__card glass-surface">
        <div className="agent-wizard__progress" aria-hidden>
          {STEPS.map((s, i) => (
            <span
              key={s}
              className="agent-wizard__pill"
              data-state={i < stepIdx ? 'done' : i === stepIdx ? 'current' : 'todo'}
            />
          ))}
        </div>
        <h2 className="agent-wizard__title">{t('settings.agentWizard.title')}</h2>

        <div className="agent-wizard__step">
          {step === 'type' && (
            <div className="agent-wizard__choices">
              <button
                type="button"
                className={`agent-wizard__choice ${runtime === 'api' ? 'is-active' : ''}`}
                onClick={() => setRuntime('api')}
              >
                <strong>{t('settings.agentWizard.typeApi')}</strong>
                <span>{t('settings.agentWizard.typeApiDesc')}</span>
              </button>
              <button
                type="button"
                className={`agent-wizard__choice ${runtime === 'cli' ? 'is-active' : ''}`}
                onClick={() => setRuntime('cli')}
              >
                <strong>{t('settings.agentWizard.typeCli')}</strong>
                <span>{t('settings.agentWizard.typeCliDesc')}</span>
              </button>
            </div>
          )}

          {step === 'configure' && runtime === 'api' && (
            <>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.provider')}</span>
                <select
                  value={providerId}
                  onChange={(e) => onPickProvider(e.target.value as ApiAgentProviderId)}
                >
                  {API_AGENT_PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.model')}</span>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={provider.defaultModel}
                  spellCheck={false}
                />
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.agentWizard.apiKeyOptional')}</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  spellCheck={false}
                />
              </label>
            </>
          )}

          {step === 'configure' && runtime === 'cli' && (
            <>
              <label className="modal__label modal__label--full">
                <span>{t('settings.command')}</span>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="aider"
                  spellCheck={false}
                />
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.argsLabel')}</span>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="--model opus --yes"
                  spellCheck={false}
                />
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.engine')}</span>
                <select value={engine} onChange={(e) => setEngine(e.target.value as AgentEngine)}>
                  <option value="claude">{t('settings.customAgents.engineClaude')}</option>
                  <option value="codex">{t('settings.customAgents.engineCodex')}</option>
                </select>
              </label>
            </>
          )}

          {step === 'appearance' && (
            <>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.name')}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.customAgents.namePlaceholder')}
                  spellCheck={false}
                />
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.icon')}</span>
                <input
                  type="text"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="Terminal"
                  spellCheck={false}
                  list="agent-wizard-icons"
                />
                <datalist id="agent-wizard-icons">
                  {ICON_SUGGESTIONS.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.accentColor')}</span>
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder="#d97757"
                  spellCheck={false}
                />
              </label>
              <label className="modal__label modal__label--full">
                <span>{t('settings.customAgents.tags')}</span>
                <input
                  type="text"
                  value={tagsRaw}
                  onChange={(e) => setTagsRaw(e.target.value)}
                  placeholder={t('settings.customAgents.tagsPlaceholder')}
                  spellCheck={false}
                />
              </label>
            </>
          )}

          {step === 'review' && (
            <div className="agent-wizard__review">
              <p className="modal__note">{t('settings.agentWizard.reviewSummary')}</p>
              <ul className="agent-wizard__summary">
                <li>
                  {t('settings.customAgents.name')}: <strong>{name.trim() || '—'}</strong>
                </li>
                <li>
                  {t('settings.customAgents.runtime')}:{' '}
                  <strong>
                    {runtime === 'api'
                      ? t('settings.agentWizard.typeApi')
                      : t('settings.agentWizard.typeCli')}
                  </strong>
                </li>
                {runtime === 'api' ? (
                  <>
                    <li>
                      {t('settings.customAgents.provider')}: <strong>{provider.label}</strong>
                    </li>
                    <li>
                      {t('settings.customAgents.model')}: <strong>{model.trim() || '—'}</strong>
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      {t('settings.command')}: <strong>{command.trim() || '—'}</strong>
                    </li>
                    <li>
                      {t('settings.customAgents.engine')}: <strong>{engine}</strong>
                    </li>
                  </>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="agent-wizard__footer">
          <button type="button" className="toolbar__btn" onClick={stepIdx === 0 ? onCancel : goPrev}>
            {stepIdx === 0 ? t('settings.agentWizard.cancel') : t('settings.agentWizard.back')}
          </button>
          {step === 'review' ? (
            <button
              type="button"
              className="agent-wizard__primary"
              onClick={() => void handleCreate()}
            >
              {t('settings.agentWizard.create')}
            </button>
          ) : (
            <button
              type="button"
              className="agent-wizard__primary"
              onClick={goNext}
              disabled={!canNext}
            >
              {t('settings.agentWizard.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
