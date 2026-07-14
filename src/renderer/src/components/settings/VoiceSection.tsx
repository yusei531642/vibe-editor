// Issue #825: 音声指揮 (Voice Direction, Beta) セクション。
//
// 構成:
//   - Beta 警告 + 機能 enable toggle
//   - API key 入力欄 (未保存: <input> + 保存ボタン / 保存済み: masked + クリアボタン)
//     入力欄の下に OS keyring の保管先を明示する説明文。
//   - モデル / AI の声 / 言語 / 入出力デバイス / トグルショートカット / 確認モード
//   - 初回 enable 時 disclaimer modal
//
// デザイン方針 (claude-design skill):
//   - 1px hairline border, radius 10px (input) / 14px (modal), 影は overlay のみ
//   - select/radio/toggle は appearance:none でカスタム描画
//   - アクセント (terra cotta) は少面積で、bypass 警告は warning オリーブで stripe
//
// 設計上の制約:
//   - API key は `window.api.voice.setApiKey()` 経由でしか書き込まない。値は IPC で
//     返さないので、UI が保存済みの値を再表示する経路は存在しない (= ユーザーが
//     クリアして再入力する設計)。
//   - 入出力デバイスは初回マウントで `getUserMedia({audio:true})` を一瞬走らせて
//     label を解放してから enumerateDevices() を呼ぶ。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Lock, Mic, RotateCcw, Volume2 } from 'lucide-react';
import type { AppSettings, VoiceSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useModalA11y } from '../../lib/hooks/use-modal-a11y';
import { useToast } from '../../lib/toast-context';
import {
  ensureAudioPermissionForLabels,
  listAudioDevices,
  type AudioDevice
} from '../../lib/voice-audio-devices';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

const VOICE_OPTIONS = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
const MODEL_OPTIONS = ['gpt-realtime-2', 'gpt-realtime', 'gpt-4o-realtime-preview'];
// 言語の表示名は各言語名で直接記述 (i18n に依存させず、選択肢自体が言語のサンプルになる)。
const LANGUAGE_OPTIONS = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' }
];

export function VoiceSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const voice: VoiceSettings = draft.voice ?? {};

  const setVoice = useCallback(
    (patch: Partial<VoiceSettings>): void => {
      update('voice', { ...(draft.voice ?? {}), ...patch });
    },
    [draft.voice, update]
  );

  // ---- API key state ----
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  // ---- disclaimer modal (saveApiKey から呼ぶので先に宣言) ----
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const onDisclaimerAck = useCallback(() => {
    setVoice({ hasShownDisclaimer: true });
    setDisclaimerOpen(false);
  }, [setVoice]);

  useEffect(() => {
    let cancelled = false;
    window.api.voice
      .hasApiKey()
      .then((exists) => {
        if (!cancelled) setHasApiKey(exists);
      })
      .catch(() => {
        if (!cancelled) setHasApiKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveApiKey = useCallback(async () => {
    const trimmed = apiKeyInput.trim();
    if (trimmed.length === 0) return;
    setSavingKey(true);
    try {
      await window.api.voice.setApiKey(trimmed);
      setHasApiKey(true);
      setApiKeyInput('');
      setShowApiKey(false);
      showToast(t('voice.toast.apiKeySaved'), { tone: 'success', duration: 3000 });
      if (!voice.hasShownDisclaimer) {
        setDisclaimerOpen(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('voice.error.keyringUnavailable') + (msg ? `: ${msg}` : ''), {
        tone: 'error',
        duration: 6000
      });
    } finally {
      setSavingKey(false);
    }
  }, [apiKeyInput, voice.hasShownDisclaimer, showToast, t]);

  const clearApiKey = useCallback(async () => {
    if (!window.confirm(t('settings.voice.apiKey.clearConfirm'))) return;
    try {
      await window.api.voice.clearApiKey();
      setHasApiKey(false);
      setApiKeyInput('');
      showToast(t('voice.toast.apiKeyCleared'), { tone: 'info', duration: 3000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('voice.error.keyringUnavailable') + (msg ? `: ${msg}` : ''), {
        tone: 'error',
        duration: 6000
      });
    }
  }, [showToast, t]);

  // ---- audio device discovery ----
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureAudioPermissionForLabels();
        if (cancelled) return;
        const list = await listAudioDevices();
        if (cancelled) return;
        setInputs(list.inputs);
        setOutputs(list.outputs);
      } catch (err) {
        if (!cancelled) {
          setDeviceLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- shortcut capture ----
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const onShortcutKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!capturingShortcut) return;
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Meta');
      const key = e.key;
      if (key.length === 1 && /[A-Za-z0-9]/.test(key)) {
        parts.push(key.toUpperCase());
      } else if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') {
        parts.push(key);
      }
      if (parts.length >= 2) {
        setVoice({ toggleShortcut: parts.join('+') });
        setCapturingShortcut(false);
      }
    },
    [capturingShortcut, setVoice]
  );

  const confirmationMode = voice.confirmationMode ?? 'always';

  const apiKeyDisplay = useMemo(() => {
    if (hasApiKey === null) return '';
    if (hasApiKey) return '••••••••••••••••';
    return apiKeyInput;
  }, [hasApiKey, apiKeyInput]);

  return (
    <>
      {/* ── Beta ヘッダ + enable トグル ── */}
      <section className="modal__section">
        <div className="voice-section__header">
          <h3>
            {t('settings.section.voice.title')}
            <span className="voice-beta-badge">BETA</span>
          </h3>
          <p className="voice-section__beta-warning">
            {t('settings.voice.beta.warning')}
          </p>
        </div>

        <label className="mcp-toggle">
          <input
            type="checkbox"
            checked={voice.enabled ?? false}
            onChange={(e) => {
              setVoice({ enabled: e.target.checked });
              if (e.target.checked && !voice.hasShownDisclaimer && hasApiKey) {
                setDisclaimerOpen(true);
              }
            }}
          />
          <span>{t('settings.voice.enabled.label')}</span>
        </label>
      </section>

      {/* ── API key ── */}
      <section className="modal__section">
        <h3>{t('settings.voice.apiKey.label')}</h3>
        <div className="voice-field">
          <div className="voice-input-row">
            <input
              type={showApiKey || hasApiKey ? 'text' : 'password'}
              className={`voice-input${hasApiKey ? ' voice-input--masked' : ''}`}
              value={apiKeyDisplay}
              readOnly={!!hasApiKey}
              disabled={!!hasApiKey}
              placeholder={t('settings.voice.apiKey.placeholder')}
              onChange={(e) => setApiKeyInput(e.target.value)}
              aria-label={t('settings.voice.apiKey.label')}
            />
            {!hasApiKey && (
              <button
                type="button"
                className="voice-btn voice-btn--icon"
                onClick={() => setShowApiKey((v) => !v)}
                aria-label={showApiKey ? t('common.hide') : t('common.show')}
                title={showApiKey ? t('common.hide') : t('common.show')}
              >
                {showApiKey ? (
                  <EyeOff size={14} strokeWidth={1.75} />
                ) : (
                  <Eye size={14} strokeWidth={1.75} />
                )}
              </button>
            )}
            {hasApiKey ? (
              <button type="button" className="voice-btn" onClick={clearApiKey}>
                {t('settings.voice.apiKey.clear')}
              </button>
            ) : (
              <button
                type="button"
                className="voice-btn voice-btn--primary"
                onClick={saveApiKey}
                disabled={savingKey || apiKeyInput.trim().length === 0}
              >
                {savingKey ? t('common.saving') : t('settings.voice.apiKey.save')}
              </button>
            )}
          </div>
          <p className="voice-keyring-notice">
            <Lock
              size={14}
              strokeWidth={1.75}
              className="voice-keyring-notice__icon"
            />
            <span>{t('settings.voice.apiKey.savedNotice')}</span>
          </p>
        </div>
      </section>

      {/* ── モデル ── */}
      <section className="modal__section">
        <h3>{t('settings.voice.model.label')}</h3>
        <select
          className="voice-select"
          value={voice.model ?? 'gpt-realtime-2'}
          onChange={(e) => setVoice({ model: e.target.value })}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </section>

      {/* ── AI の声 ── */}
      <section className="modal__section">
        <h3>{t('settings.voice.voiceName.label')}</h3>
        <select
          className="voice-select"
          value={voice.voiceName ?? 'alloy'}
          onChange={(e) => setVoice({ voiceName: e.target.value })}
        >
          {VOICE_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </section>

      {/* ── 言語 ── */}
      <section className="modal__section">
        <h3>{t('settings.voice.language.label')}</h3>
        <select
          className="voice-select"
          value={voice.language ?? 'ja'}
          onChange={(e) => setVoice({ language: e.target.value })}
        >
          {LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </section>

      {/* ── 入力デバイス ── */}
      <section className="modal__section">
        <h3>
          <Mic size={12} strokeWidth={1.75} style={{ marginRight: 6 }} />
          {t('settings.voice.inputDevice.label')}
        </h3>
        {deviceLoadError && (
          <p className="voice-field__hint" style={{ color: 'var(--danger, #cf3a3a)' }}>
            {deviceLoadError}
          </p>
        )}
        <select
          className="voice-select"
          value={voice.inputDeviceId ?? ''}
          onChange={(e) => setVoice({ inputDeviceId: e.target.value })}
        >
          <option value="">{t('common.systemDefault')}</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId}
            </option>
          ))}
        </select>
      </section>

      {/* ── 出力デバイス ── */}
      <section className="modal__section">
        <h3>
          <Volume2 size={12} strokeWidth={1.75} style={{ marginRight: 6 }} />
          {t('settings.voice.outputDevice.label')}
        </h3>
        <select
          className="voice-select"
          value={voice.outputDeviceId ?? ''}
          onChange={(e) => setVoice({ outputDeviceId: e.target.value })}
        >
          <option value="">{t('common.systemDefault')}</option>
          {outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId}
            </option>
          ))}
        </select>
      </section>

      {/* ── ショートカット ── */}
      <section className="modal__section">
        <h3>{t('settings.voice.shortcut.label')}</h3>
        <div className="voice-input-row">
          <input
            type="text"
            className="voice-input voice-input--shortcut"
            value={voice.toggleShortcut ?? ''}
            placeholder={
              capturingShortcut
                ? t('settings.voice.shortcut.capturing')
                : 'Ctrl+Shift+V'
            }
            readOnly
            data-capturing={capturingShortcut ? 'true' : 'false'}
            onFocus={() => setCapturingShortcut(true)}
            onBlur={() => setCapturingShortcut(false)}
            onKeyDown={onShortcutKeyDown}
          />
          <button
            type="button"
            className="voice-btn voice-btn--icon"
            onClick={() => setVoice({ toggleShortcut: undefined })}
            title={t('settings.voice.shortcut.reset')}
            aria-label={t('settings.voice.shortcut.reset')}
          >
            <RotateCcw size={13} strokeWidth={1.75} />
          </button>
        </div>
      </section>

      {/* ── 送信時の確認モード ── */}
      <section className="modal__section">
        <h3>{t('settings.voice.confirmation.label')}</h3>
        <div className="voice-radio-group">
          <label
            className={`voice-radio${
              confirmationMode === 'always' ? ' voice-radio--selected' : ''
            }`}
          >
            <input
              type="radio"
              name="voice-confirmation-mode"
              value="always"
              checked={confirmationMode === 'always'}
              onChange={() => setVoice({ confirmationMode: 'always' })}
            />
            <span className="voice-radio__body">
              <span className="voice-radio__title">
                {t('settings.voice.confirmation.always')}
              </span>
            </span>
          </label>
          <label
            className={`voice-radio${
              confirmationMode === 'bypass' ? ' voice-radio--selected' : ''
            }`}
          >
            <input
              type="radio"
              name="voice-confirmation-mode"
              value="bypass"
              checked={confirmationMode === 'bypass'}
              onChange={() => setVoice({ confirmationMode: 'bypass' })}
            />
            <span className="voice-radio__body">
              <span className="voice-radio__title">
                {t('settings.voice.confirmation.bypass')}
              </span>
            </span>
          </label>
        </div>
        {confirmationMode === 'bypass' && (
          <p className="voice-section__bypass-warning">
            {t('settings.voice.confirmation.bypassWarning')}
          </p>
        )}
      </section>

      {disclaimerOpen && (
        <DisclaimerModal onAck={onDisclaimerAck} onCancel={() => setDisclaimerOpen(false)} />
      )}
    </>
  );
}

function DisclaimerModal({
  onAck,
  onCancel
}: {
  onAck: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const modal = useModalA11y(onCancel);
  return (
    <div className="voice-disclaimer-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={modal.dialogRef}
        className="voice-disclaimer-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-disclaimer-title"
        tabIndex={-1}
        data-modal-escape-owner="true"
      >
        <h3 id="voice-disclaimer-title">
          <Mic size={16} strokeWidth={1.75} />
          {t('settings.voice.disclaimer.title')}
        </h3>
        <div className="voice-disclaimer-modal__body">
          {t('settings.voice.disclaimer.body')
            .split('\n')
            .map((line, i) => (
              <p key={i}>{line}</p>
            ))}
        </div>
        <div className="voice-disclaimer-modal__footer">
          <button type="button" className="voice-btn voice-btn--primary" onClick={onAck}>
            {t('settings.voice.disclaimer.ack')}
          </button>
        </div>
      </div>
    </div>
  );
}
