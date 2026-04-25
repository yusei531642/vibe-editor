import { useEffect, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import type { AgentConfig, AppSettings } from '../../../types/shared';
import { DEFAULT_SETTINGS } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useSpringMount } from '../lib/use-animated-mount';
import { EDITOR_FONT_PRESETS, UI_FONT_PRESETS } from '../lib/settings-options';
import { LanguageSection } from './settings/LanguageSection';
import { ThemeSection } from './settings/ThemeSection';
import { FontFamilySection } from './settings/FontFamilySection';
import { TerminalSection } from './settings/TerminalSection';
import { RoleProfilesSection } from './settings/RoleProfilesSection';
import { DensitySection } from './settings/DensitySection';
import { CommandOptionsSection } from './settings/CommandOptionsSection';
import { CustomAgentEditor } from './settings/CustomAgentEditor';
import { McpSection } from './settings/McpSection';

interface SettingsModalProps {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onApply: (next: AppSettings) => void;
  /**
   * Issue #28 対応: 現在は未使用 (Reset ボタンは draft だけを戻し、永続化は Apply に委ねる)。
   * 互換のためシグネチャは残している。将来「即時に保存したいリセット」導線が欲しくなったら
   * 呼び出し元に戻せる。
   */
  onReset?: () => void;
  /** 初回セットアップウィザードを再表示する (General セクションの専用ボタン) */
  onReplayOnboarding?: () => void;
}

/**
 * SectionId はカスタムエージェント対応のため動的な文字列。
 * 固定セクション: 'general' | 'appearance' | 'fonts' | 'claude' | 'codex' | 'mcp'
 * カスタムエージェント: `custom:${agentId}`
 */
type SectionId = string;

export function SettingsModal({
  open,
  initial,
  onClose,
  onApply,
  onReplayOnboarding
}: SettingsModalProps): JSX.Element | null {
  const t = useT();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [activeSection, setActiveSection] = useState<SectionId>('general');

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setActiveSection('general');
    }
  }, [open, initial]);

  // カスタムエージェントが削除された結果、activeSection が迷子になったら 'general' に戻す
  useEffect(() => {
    if (!activeSection.startsWith('custom:')) return;
    const exists = (draft.customAgents ?? []).some(
      (a) => `custom:${a.id}` === activeSection
    );
    if (!exists) setActiveSection('general');
  }, [activeSection, draft.customAgents]);

  const { mounted, dataState, motion } = useSpringMount(open, 180);
  if (!mounted) return null;

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const handleApply = (): void => {
    onApply(draft);
    onClose();
  };

  // Issue #28: Reset は draft だけを DEFAULT_SETTINGS に戻す。
  // 永続化は Apply / Cancel のタイミングに揃える (footer の 2 ボタンと整合)。
  const handleReset = (): void => {
    setDraft({ ...DEFAULT_SETTINGS });
  };

  const isJa = draft.language === 'ja';
  const customAgents = draft.customAgents ?? [];

  // 固定ラベル
  const fixedLabels: Record<string, { label: string; title: string; desc: string }> = isJa
    ? {
        general: { label: '一般', title: '一般', desc: '言語と密度設定' },
        appearance: { label: '表示', title: '表示', desc: 'テーマと配色' },
        fonts: { label: 'フォント', title: 'フォント', desc: 'UI / エディタ / ターミナルのフォント' },
        claude: { label: 'Claude Code', title: 'Claude Code', desc: '起動コマンドと引数' },
        codex: { label: 'Codex', title: 'Codex', desc: '起動コマンドと引数' },
        roles: { label: 'ロール定義', title: 'ロール定義', desc: 'チームメンバーの役割テンプレ' },
        mcp: { label: 'MCP', title: 'MCP', desc: 'vibe-team MCP の導入方法' }
      }
    : {
        general: { label: 'General', title: 'General', desc: 'Language and density' },
        appearance: { label: 'Appearance', title: 'Appearance', desc: 'Theme and surfaces' },
        fonts: { label: 'Fonts', title: 'Typography', desc: 'UI / editor / terminal fonts' },
        claude: { label: 'Claude Code', title: 'Claude Code', desc: 'Launch command and args' },
        codex: { label: 'Codex', title: 'Codex', desc: 'Launch command and args' },
        roles: { label: 'Role profiles', title: 'Role profiles', desc: 'Team member role templates' },
        mcp: { label: 'MCP', title: 'MCP', desc: 'How to install vibe-team MCP' }
      };

  /** 指定 id のラベル情報を返す (固定 + カスタム動的) */
  const labelOf = (id: SectionId): { label: string; title: string; desc: string } => {
    if (fixedLabels[id]) return fixedLabels[id];
    if (id.startsWith('custom:')) {
      const a = customAgents.find((x) => `custom:${x.id}` === id);
      const name = a?.name || (isJa ? '（無名）' : '(untitled)');
      return {
        label: name,
        title: name,
        desc: isJa ? 'カスタムエージェント設定' : 'Custom agent settings'
      };
    }
    if (id === '__addCustom') {
      return {
        label: isJa ? '+ 追加' : '+ Add',
        title: isJa ? '+ 追加' : '+ Add',
        desc: ''
      };
    }
    return { label: id, title: id, desc: '' };
  };

  /** 新規カスタムエージェントを追加して編集画面へ遷移 */
  const addCustomAgent = (): void => {
    const id = `ca_${Math.random().toString(36).slice(2, 10)}`;
    const agent: AgentConfig = {
      id,
      name: isJa ? '新しいエージェント' : 'New agent',
      command: '',
      args: '',
      cwd: ''
    };
    const next = [...customAgents, agent];
    update('customAgents', next);
    setActiveSection(`custom:${id}`);
  };

  const groups: Array<{ label: string | null; items: SectionId[] }> = [
    { label: null, items: ['general', 'appearance', 'fonts'] },
    {
      label: isJa ? 'エージェント' : 'Agents',
      items: [
        'claude',
        'codex',
        ...customAgents.map((a) => `custom:${a.id}`),
        '__addCustom'
      ]
    },
    { label: isJa ? 'チーム' : 'Team', items: ['roles'] },
    { label: 'MCP', items: ['mcp'] }
  ];

  const renderSection = (id: SectionId): JSX.Element | null => {
    switch (id) {
      case 'general':
        return (
          <>
            <LanguageSection draft={draft} update={update} />
            <DensitySection draft={draft} update={update} />
            {onReplayOnboarding && (
              <div className="settings-shell__replay">
                <button
                  type="button"
                  className="toolbar__btn"
                  onClick={() => {
                    onClose();
                    onReplayOnboarding();
                  }}
                >
                  {t('onboarding.replay')}
                </button>
              </div>
            )}
          </>
        );
      case 'appearance':
        return <ThemeSection draft={draft} update={update} />;
      case 'fonts':
        return (
          <>
            <FontFamilySection
              title={isJa ? 'UI フォント' : 'UI Font'}
              familyKey="uiFontFamily"
              sizeKey="uiFontSize"
              presets={UI_FONT_PRESETS}
              draft={draft}
              update={update}
            />
            <FontFamilySection
              title={isJa ? 'エディタフォント (Monaco)' : 'Editor Font (Monaco)'}
              familyKey="editorFontFamily"
              sizeKey="editorFontSize"
              presets={EDITOR_FONT_PRESETS}
              draft={draft}
              update={update}
            />
            <TerminalSection draft={draft} update={update} />
          </>
        );
      case 'claude':
        return (
          <CommandOptionsSection
            title={isJa ? '起動オプション' : 'Launch options'}
            commandKey="claudeCommand"
            commandPlaceholder="claude"
            argsKey="claudeArgs"
            argsLabel={isJa ? '引数（空白区切り、ダブルクォートで空白を含む値）' : 'Arguments'}
            argsPlaceholder='--model opus --add-dir "D:/other project"'
            cwdKey="claudeCwd"
            cwdLabel={isJa ? '作業ディレクトリ（空なら現在のプロジェクトルート）' : 'Working directory'}
            cwdPlaceholder={isJa ? '（未設定）' : '(unset)'}
            note={
              isJa
                ? '変更後は再起動でターミナルに反映されます。'
                : 'Restart terminals to apply changes.'
            }
            draft={draft}
            update={update}
          />
        );
      case 'codex':
        return (
          <CommandOptionsSection
            title={isJa ? '起動オプション' : 'Launch options'}
            commandKey="codexCommand"
            commandPlaceholder="codex"
            argsKey="codexArgs"
            argsLabel={isJa ? '引数（空白区切り）' : 'Arguments'}
            argsPlaceholder="--model o3"
            draft={draft}
            update={update}
          />
        );
      case 'roles':
        return <RoleProfilesSection />;
      case 'mcp':
        return <McpSection draft={draft} update={update} />;
      default:
        if (id.startsWith('custom:')) {
          const a = customAgents.find((x) => `custom:${x.id}` === id);
          if (!a) return null;
          return <CustomAgentEditor agent={a} draft={draft} update={update} />;
        }
        return null;
    }
  };

  const current = labelOf(activeSection);

  return (
    <div
      className="modal-backdrop"
      data-state={dataState}
      data-motion={motion}
      onClick={onClose}
    >
      <div
        className="modal modal--settings"
        data-state={dataState}
        data-motion={motion}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <div className="modal__title-group" style={{ display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              className="settings-back-btn"
              onClick={onClose}
              aria-label={isJa ? '戻る' : 'Back'}
              title={isJa ? '戻る' : 'Back'}
            >
              <ArrowLeft size={16} strokeWidth={2} />
            </button>
            <h2>{t('settings.title')}</h2>
          </div>
        </header>

        <div className="modal__body modal__body--settings">
          <nav className="settings-shell__nav" aria-label="Settings sections">
            {groups.map((g, gi) => (
              <div key={gi} style={{ display: 'contents' }}>
                {g.label && (
                  <div className="settings-shell__nav-group-label">{g.label}</div>
                )}
                {g.items.map((id) => {
                  // 擬似項目: カスタムエージェント追加ボタン
                  if (id === '__addCustom') {
                    return (
                      <button
                        key={id}
                        type="button"
                        className="settings-shell__nav-item settings-shell__nav-item--add"
                        onClick={addCustomAgent}
                      >
                        <Plus size={13} strokeWidth={2} />
                        <span className="settings-shell__nav-label">
                          {t('settings.customAgents.add')}
                        </span>
                      </button>
                    );
                  }
                  const { label } = labelOf(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`settings-shell__nav-item${
                        id === activeSection ? ' is-active' : ''
                      }`}
                      onClick={() => setActiveSection(id)}
                    >
                      <span className="settings-shell__nav-label">{label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="settings-shell__content">
            <div>
              <h2 className="settings-shell__pane-title">{current.title}</h2>
              <p className="settings-shell__pane-desc">{current.desc}</p>
            </div>
            <div key={activeSection} className="settings-shell__panel">
              {renderSection(activeSection)}
            </div>
          </div>
        </div>

        <footer className="modal__footer">
          <button type="button" className="toolbar__btn" onClick={handleReset}>
            {t('settings.reset')}
          </button>
          <div className="modal__footer-right">
            <button type="button" className="toolbar__btn" onClick={onClose}>
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className="toolbar__btn toolbar__btn--primary"
              onClick={handleApply}
            >
              {t('settings.apply')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
