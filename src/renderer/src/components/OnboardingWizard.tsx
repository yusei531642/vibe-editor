import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, FolderOpen } from 'lucide-react';
import type { AppSettings, Language, ThemeName } from '../../../types/shared';
import { translate } from '../lib/i18n';
import { useSettings } from '../lib/settings-context';
import { useSpringMount } from '../lib/use-animated-mount';
import { THEMES, applyTheme } from '../lib/themes';

type Step = 'welcome' | 'appearance' | 'workspace' | 'done';
const STEP_ORDER: Step[] = ['welcome', 'appearance', 'workspace', 'done'];

interface OnboardingWizardProps {
  onComplete: (patch: Partial<AppSettings>) => void | Promise<void>;
}

const SUPPORTED_THEMES: ThemeName[] = [
  'claude-dark',
  'claude-light',
  'dark',
  'midnight',
  'light',
  'glass'
];

const THEME_LABEL: Record<ThemeName, { ja: string; en: string }> = {
  'claude-dark': { ja: 'Claude Dark', en: 'Claude Dark' },
  'claude-light': { ja: 'Claude Light', en: 'Claude Light' },
  dark: { ja: 'ダーク', en: 'Dark' },
  light: { ja: 'ライト', en: 'Light' },
  midnight: { ja: 'ミッドナイト', en: 'Midnight' },
  glass: { ja: 'グラス', en: 'Glass' }
};

function guessLanguage(): Language {
  const loc = (navigator.language || 'en').toLowerCase();
  return loc.startsWith('ja') ? 'ja' : 'en';
}

function shortName(abs: string): string {
  const parts = abs.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || abs;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps): JSX.Element | null {
  const { settings } = useSettings();
  const { mounted, dataState } = useSpringMount(true, 220);

  const [step, setStep] = useState<Step>('welcome');
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [draftLanguage, setDraftLanguage] = useState<Language>(
    settings.language || guessLanguage()
  );
  const [draftTheme, setDraftTheme] = useState<ThemeName>(settings.theme || 'claude-dark');
  const [draftFolder, setDraftFolder] = useState<string>('');
  const [folderBusy, setFolderBusy] = useState(false);

  // 元のテーマ/言語を覚えておき、ウィザードがキャンセル (あるいは絶対に閉じないが念のため) された
  // 場合に備える。基本は完了時に draftTheme がそのまま採用される。
  const originalThemeRef = useRef<ThemeName>(settings.theme);
  const originalUiFontFamilyRef = useRef(settings.uiFontFamily);
  const originalUiFontSizeRef = useRef(settings.uiFontSize);
  const completedRef = useRef(false);
  useEffect(() => {
    originalThemeRef.current = settings.theme;
    originalUiFontFamilyRef.current = settings.uiFontFamily;
    originalUiFontSizeRef.current = settings.uiFontSize;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // テーマのライブプレビュー (DOM 書き換えのみで永続化はしない)
  useEffect(() => {
    applyTheme(draftTheme, settings.uiFontFamily, settings.uiFontSize);
  }, [draftTheme, settings.uiFontFamily, settings.uiFontSize]);

  // Issue #164: ウィザードが完了せず unmount された場合 (外部から閉じられた等) に
  // ライブプレビューで書き換えた DOM を必ず元の theme に戻す。
  useEffect(() => {
    return () => {
      if (completedRef.current) return; // 通常完了時はそのまま draftTheme が永続化される
      applyTheme(
        originalThemeRef.current,
        originalUiFontFamilyRef.current,
        originalUiFontSizeRef.current
      );
    };
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(draftLanguage, key, params),
    [draftLanguage]
  );

  const themeVars = THEMES[draftTheme];

  const goNext = useCallback(() => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < 0 || idx >= STEP_ORDER.length - 1) return;
    setDirection('next');
    setStep(STEP_ORDER[idx + 1]);
  }, [step]);

  const goPrev = useCallback(() => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx <= 0) return;
    setDirection('prev');
    setStep(STEP_ORDER[idx - 1]);
  }, [step]);

  const chooseFolder = useCallback(async () => {
    if (!window.api?.dialog) return;
    setFolderBusy(true);
    try {
      const picked = await window.api.dialog.openFolder(t('onboarding.workspace.choose'));
      if (picked) setDraftFolder(picked);
    } finally {
      setFolderBusy(false);
    }
  }, [t]);

  const finish = useCallback(() => {
    completedRef.current = true; // unmount cleanup でロールバックしない
    // lastOnboardedVersion は呼び出し側 (App.tsx) で現在の app version を上乗せする。
    const patch: Partial<AppSettings> = {
      language: draftLanguage,
      theme: draftTheme
    };
    if (draftFolder) patch.lastOpenedRoot = draftFolder;
    void onComplete(patch);
  }, [draftLanguage, draftTheme, draftFolder, onComplete]);

  // Issue #197: 旧実装は Done 画面を 2 秒で自動完了させていたが、
  //   - スクリーンリーダーは <dl> サマリ (language/theme/folder) を読み始めた直後に modal が消える
  //   - 認知負荷の高いユーザー / スクリーンショット作成が画面を確認できない
  //   - WCAG 2.2.1 (Timing Adjustable) 違反
  // 「完了」CTA はすでに画面下部にあるので、自動 finish を撤去してユーザー操作のみで閉じる仕様にする。

  const totalSteps = STEP_ORDER.length;
  const currentStepNumber = STEP_ORDER.indexOf(step) + 1;
  const stepLabelKey = `onboarding.stepLabel.${step}` as const;

  // workspace ステップはフォルダ選択を強制する (skip 不可)。
  // 未選択のまま Next できないようにし、Enter ショートカットも無効化する。
  const canAdvance = !(step === 'workspace' && !draftFolder);

  // Enter キーで「次へ」を進めるショートカット (welcome / appearance / workspace).
  // done では finish を発火、入力中 (textarea/input) では無効化する。
  // workspace でフォルダ未選択のときも素通りさせない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (!canAdvance) return;
      e.preventDefault();
      if (step === 'done') finish();
      else goNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, goNext, finish, canAdvance]);

  if (!mounted) return null;

  return (
    <div
      className="onboarding"
      data-state={dataState}
      role="dialog"
      aria-modal="true"
      aria-label="vibe-editor setup"
    >
      <div className="onboarding__card" data-state={dataState}>
        <div className="onboarding__progress" aria-hidden>
          <span className="onboarding__progress-counter">
            <strong>
              {String(currentStepNumber).padStart(2, '0')}
            </strong>
            {' '}/{' '}
            {String(totalSteps).padStart(2, '0')}
          </span>
          <span className="onboarding__progress-rule" />
          <span className="onboarding__progress-label">{t(stepLabelKey)}</span>
        </div>

        <div
          key={step}
          className="onboarding__step"
          data-step={step}
          data-direction={direction}
        >
          {step === 'welcome' && (
            <WelcomeStep t={t} onNext={goNext} />
          )}
          {step === 'appearance' && (
            <AppearanceStep
              t={t}
              draftLanguage={draftLanguage}
              draftTheme={draftTheme}
              onLanguageChange={setDraftLanguage}
              onThemeChange={setDraftTheme}
            />
          )}
          {step === 'workspace' && (
            <WorkspaceStep
              t={t}
              folder={draftFolder}
              busy={folderBusy}
              onChoose={chooseFolder}
              onClear={() => setDraftFolder('')}
            />
          )}
          {step === 'done' && (
            <DoneStep
              t={t}
              draftLanguage={draftLanguage}
              draftTheme={draftTheme}
              draftFolder={draftFolder}
              themeAccent={themeVars.accent}
            />
          )}
        </div>

        {step !== 'welcome' && step !== 'done' && (
          <div className="onboarding__nav">
            <button
              type="button"
              className="onboarding__btn onboarding__btn--ghost"
              onClick={goPrev}
            >
              <ChevronLeft size={15} strokeWidth={2} />
              <span>{t('onboarding.back')}</span>
            </button>
            <div className="onboarding__nav-right">
              <button
                type="button"
                className="onboarding__btn onboarding__btn--primary"
                onClick={goNext}
                disabled={!canAdvance}
                aria-disabled={!canAdvance}
              >
                <span>{t('onboarding.next')}</span>
                <ArrowRight size={15} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="onboarding__nav onboarding__nav--center">
            <button
              type="button"
              className="onboarding__btn onboarding__btn--primary"
              onClick={finish}
            >
              <span>{t('onboarding.done.cta')}</span>
              <ArrowRight size={15} strokeWidth={2} />
            </button>
          </div>
        )}

        <div className="onboarding__nav-hint" aria-hidden>
          <span className="onboarding__nav-kbd">↵</span>
          <span>{t('onboarding.continueHint')}</span>
        </div>
      </div>
    </div>
  );
}

// ----- Step components -----

interface StepProps {
  t: (key: string, params?: Record<string, string | number>) => string;
}

function WelcomeStep({ t, onNext }: StepProps & { onNext: () => void }): JSX.Element {
  return (
    <div className="onboarding__hero">
      <img
        className="onboarding__brand onboarding__brand--image"
        src="/vibe-editor.png"
        alt="vibe-editor"
        draggable={false}
      />
      <span className="onboarding__eyebrow">{t('onboarding.welcome.eyebrow')}</span>
      <h1 className="onboarding__title">{t('onboarding.welcome.title')}</h1>
      <p className="onboarding__subtitle">{t('onboarding.welcome.subtitle')}</p>
      <div className="onboarding__nav onboarding__nav--center">
        <button
          type="button"
          className="onboarding__btn onboarding__btn--primary onboarding__btn--large"
          onClick={onNext}
        >
          <span>{t('onboarding.welcome.cta')}</span>
          <ArrowRight size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

interface AppearanceStepProps extends StepProps {
  draftLanguage: Language;
  draftTheme: ThemeName;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: ThemeName) => void;
}

function AppearanceStep({
  t,
  draftLanguage,
  draftTheme,
  onLanguageChange,
  onThemeChange
}: AppearanceStepProps): JSX.Element {
  return (
    <div className="onboarding__body">
      <header className="onboarding__header">
        <span className="onboarding__eyebrow">{t('onboarding.appearance.eyebrow')}</span>
        <h2 className="onboarding__title onboarding__title--sm">
          {t('onboarding.appearance.title')}
        </h2>
        <p className="onboarding__subtitle">{t('onboarding.appearance.subtitle')}</p>
      </header>

      <section className="onboarding__section">
        <div className="onboarding__section-label">{t('onboarding.appearance.language')}</div>
        <div className="onboarding__lang-row">
          {(['ja', 'en'] as Language[]).map((lang) => (
            <button
              key={lang}
              type="button"
              className="onboarding__lang-pill"
              data-active={draftLanguage === lang}
              onClick={() => onLanguageChange(lang)}
            >
              {lang === 'ja' ? '日本語' : 'English'}
            </button>
          ))}
        </div>
      </section>

      <section className="onboarding__section">
        <div className="onboarding__section-label">{t('onboarding.appearance.theme')}</div>
        <div className="onboarding__theme-grid">
          {SUPPORTED_THEMES.map((name) => {
            const v = THEMES[name];
            return (
              <button
                key={name}
                type="button"
                className="onboarding__theme-card"
                data-active={draftTheme === name}
                onClick={() => onThemeChange(name)}
                aria-pressed={draftTheme === name}
              >
                <div
                  className="onboarding__theme-preview"
                  style={{
                    background: v.bg,
                    borderColor: v.border
                  }}
                >
                  <div
                    className="onboarding__theme-preview-bar"
                    style={{ background: v.bgPanel }}
                  />
                  <div
                    className="onboarding__theme-preview-dot"
                    style={{ background: v.accent }}
                  />
                </div>
                <span className="onboarding__theme-name">{THEME_LABEL[name][draftLanguage]}</span>
                <span className="onboarding__theme-check" aria-hidden>
                  <Check size={11} strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

interface WorkspaceStepProps extends StepProps {
  folder: string;
  busy: boolean;
  onChoose: () => void;
  onClear: () => void;
}

function WorkspaceStep({
  t,
  folder,
  busy,
  onChoose,
  onClear
}: WorkspaceStepProps): JSX.Element {
  return (
    <div className="onboarding__body">
      <header className="onboarding__header">
        <span className="onboarding__eyebrow">{t('onboarding.workspace.eyebrow')}</span>
        <h2 className="onboarding__title onboarding__title--sm">
          {t('onboarding.workspace.title')}
        </h2>
        <p className="onboarding__subtitle">{t('onboarding.workspace.subtitle')}</p>
      </header>

      <section className="onboarding__section onboarding__section--folder">
        {folder ? (
          <div className="onboarding__folder-pill">
            <FolderOpen size={18} strokeWidth={1.75} className="onboarding__folder-icon" />
            <div className="onboarding__folder-info">
              <span className="onboarding__folder-name">{shortName(folder)}</span>
              <span className="onboarding__folder-path">{folder}</span>
            </div>
            <button
              type="button"
              className="onboarding__folder-clear"
              onClick={onClear}
              aria-label="clear"
            >
              ×
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="onboarding__btn onboarding__btn--ghost onboarding__btn--wide"
          onClick={onChoose}
          disabled={busy}
        >
          {folder ? t('onboarding.workspace.change') : t('onboarding.workspace.choose')}
        </button>
      </section>
    </div>
  );
}

interface DoneStepProps extends StepProps {
  draftLanguage: Language;
  draftTheme: ThemeName;
  draftFolder: string;
  themeAccent: string;
}

function DoneStep({
  t,
  draftLanguage,
  draftTheme,
  draftFolder,
  themeAccent
}: DoneStepProps): JSX.Element {
  const themeLabel = THEME_LABEL[draftTheme][draftLanguage];
  return (
    <div className="onboarding__hero">
      <div
        className="onboarding__done-mark"
        aria-hidden
        style={{ background: themeAccent }}
      >
        <Check size={36} strokeWidth={2.5} color="#fff" />
      </div>
      <span className="onboarding__eyebrow">{t('onboarding.done.eyebrow')}</span>
      <h1 className="onboarding__title">{t('onboarding.done.title')}</h1>
      <p className="onboarding__subtitle">{t('onboarding.done.subtitle')}</p>

      <dl className="onboarding__summary">
        <div className="onboarding__summary-row">
          <dt>{t('onboarding.done.summaryLanguage')}</dt>
          <dd>{draftLanguage === 'ja' ? '日本語' : 'English'}</dd>
        </div>
        <div className="onboarding__summary-row">
          <dt>{t('onboarding.done.summaryTheme')}</dt>
          <dd>{themeLabel}</dd>
        </div>
        <div className="onboarding__summary-row">
          <dt>{t('onboarding.done.summaryFolder')}</dt>
          <dd>{draftFolder ? shortName(draftFolder) : t('onboarding.done.summaryFolderNone')}</dd>
        </div>
      </dl>
    </div>
  );
}
