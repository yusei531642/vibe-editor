import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { AppSettings } from '../../../types/shared';
import { DEFAULT_SETTINGS } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useAnimatedMount } from '../lib/use-animated-mount';
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

export function SettingsModal({
  open,
  initial,
  onClose,
  onApply,
  onReset
}: SettingsModalProps): JSX.Element | null {
  const t = useT();
  const [draft, setDraft] = useState<AppSettings>(initial);

  // モーダルを開いた瞬間に最新の initial で draft を初期化
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const { mounted, state } = useAnimatedMount(open, 260);
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

  return (
    <div className="modal-backdrop" data-state={state} onClick={onClose}>
      <div className="modal" data-state={state} onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>{t('settings.title')}</h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="閉じる"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="modal__body">
          <LanguageSection draft={draft} update={update} />
          <ThemeSection draft={draft} update={update} />
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
          <DensitySection draft={draft} update={update} />
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
