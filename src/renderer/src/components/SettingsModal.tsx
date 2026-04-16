import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { AppSettings } from '../../../types/shared';
import { DEFAULT_SETTINGS } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useSpringMount } from '../lib/use-animated-mount';
import { EDITOR_FONT_PRESETS, UI_FONT_PRESETS } from '../lib/settings-options';
import { LanguageSection } from './settings/LanguageSection';
import { ThemeSection } from './settings/ThemeSection';
import { FontFamilySection } from './settings/FontFamilySection';
import { TerminalSection } from './settings/TerminalSection';
import { DensitySection } from './settings/DensitySection';
import { CommandOptionsSection } from './settings/CommandOptionsSection';

interface SettingsModalProps {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onApply: (next: AppSettings) => void;
  onReset: () => void;
}

type SettingsSectionId = 'general' | 'appearance' | 'fonts' | 'runtime';

export function SettingsModal({
  open,
  initial,
  onClose,
  onApply,
  onReset
}: SettingsModalProps): JSX.Element | null {
  const t = useT();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');

  // モーダルを開いた瞬間に最新の initial で draft を初期化
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setActiveSection('general');
    }
  }, [open, initial]);

  const { mounted, dataState, motion } = useSpringMount(open, 180);
  if (!mounted) return null;

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const handleApply = (): void => {
    onApply(draft);
    onClose();
  };

  const handleReset = (): void => {
    setDraft({ ...DEFAULT_SETTINGS });
    onReset();
  };

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(initial);

  const copy =
    draft.language === 'ja'
      ? {
          general: { label: '基本', desc: '言語と密度' },
          appearance: { label: '表示', desc: 'テーマと見た目' },
          fonts: { label: 'フォント', desc: 'UI とエディタ' },
          runtime: { label: 'エージェント', desc: 'Claude と Codex' }
        }
      : {
          general: { label: 'General', desc: 'Language and density' },
          appearance: { label: 'Appearance', desc: 'Theme and surfaces' },
          fonts: { label: 'Typography', desc: 'UI and editor fonts' },
          runtime: { label: 'Agents', desc: 'Claude and Codex' }
        };

  const sections: Array<{ id: SettingsSectionId; label: string; desc: string }> = [
    { id: 'general', label: copy.general.label, desc: copy.general.desc },
    { id: 'appearance', label: copy.appearance.label, desc: copy.appearance.desc },
    { id: 'fonts', label: copy.fonts.label, desc: copy.fonts.desc },
    { id: 'runtime', label: copy.runtime.label, desc: copy.runtime.desc }
  ];

  const currentSection = sections.find((s) => s.id === activeSection) ?? sections[0];

  const sectionContent: Record<SettingsSectionId, JSX.Element> = {
    general: (
      <>
        <LanguageSection draft={draft} update={update} />
        <DensitySection draft={draft} update={update} />
      </>
    ),
    appearance: <ThemeSection draft={draft} update={update} />,
    fonts: (
      <>
        <FontFamilySection
          title="UI フォント"
          familyKey="uiFontFamily"
          sizeKey="uiFontSize"
          presets={UI_FONT_PRESETS}
          draft={draft}
          update={update}
        />
        <FontFamilySection
          title="エディタフォント (Monaco)"
          familyKey="editorFontFamily"
          sizeKey="editorFontSize"
          presets={EDITOR_FONT_PRESETS}
          draft={draft}
          update={update}
        />
        <TerminalSection draft={draft} update={update} />
      </>
    ),
    runtime: (
      <>
        <CommandOptionsSection
          title="Claude Code 起動オプション"
          commandKey="claudeCommand"
          commandPlaceholder="claude"
          argsKey="claudeArgs"
          argsLabel="引数（空白区切り、ダブルクォートで空白を含む値）"
          argsPlaceholder='--model opus --add-dir "D:/other project"'
          cwdKey="claudeCwd"
          cwdLabel="作業ディレクトリ（空なら現在のプロジェクトルート）"
          cwdPlaceholder="（未設定）"
          note="変更後は右パネルの「再起動」ボタンでターミナルを再起動すると反映されます。"
          draft={draft}
          update={update}
        />
        <CommandOptionsSection
          title="Codex 起動オプション"
          commandKey="codexCommand"
          commandPlaceholder="codex"
          argsKey="codexArgs"
          argsLabel="引数（空白区切り）"
          argsPlaceholder="--model o3"
          draft={draft}
          update={update}
        />
      </>
    )
  };

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
          <div className="modal__title-group">
            <h2>{t('settings.title')}</h2>
            {hasChanges && <span className="modal__status">Unsaved</span>}
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="閉じる"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="modal__body modal__body--settings">
          <nav className="settings-shell__nav" aria-label="Settings sections">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-shell__nav-item${
                  section.id === activeSection ? ' is-active' : ''
                }`}
                onClick={() => setActiveSection(section.id)}
              >
                <span className="settings-shell__nav-label">{section.label}</span>
                <span className="settings-shell__nav-desc">{section.desc}</span>
              </button>
            ))}
          </nav>
          <div className="settings-shell__content">
            <div className="settings-shell__intro">
              <span className="settings-shell__eyebrow">{currentSection.label}</span>
              <p>{currentSection.desc}</p>
            </div>
            <div key={currentSection.id} className="settings-shell__panel">
              {sectionContent[currentSection.id]}
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
