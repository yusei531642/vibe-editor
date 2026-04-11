import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { AppSettings, Density, ThemeName } from '../../../types/shared';
import { DEFAULT_SETTINGS } from '../../../types/shared';

interface SettingsModalProps {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onApply: (next: AppSettings) => void;
  onReset: () => void;
}

const THEME_OPTIONS: { value: ThemeName; label: string; desc: string }[] = [
  {
    value: 'claude-dark',
    label: 'Claude Dark',
    desc: 'Anthropic公式カラー準拠。ウォームダークブラウン + コーラル #D97757（既定）'
  },
  {
    value: 'claude-light',
    label: 'Claude Light',
    desc: 'claude.ai のクリーム背景と温かい差し色を再現'
  },
  { value: 'dark', label: 'Dark', desc: 'VS Code系のクラシックダーク' },
  { value: 'midnight', label: 'Midnight', desc: '深い青紫ベース、紫アクセント' },
  { value: 'light', label: 'Light', desc: '明るい背景、暗い文字' }
];

const UI_FONT_PRESETS = [
  {
    label: 'System',
    value:
      "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Yu Gothic UI', sans-serif"
  },
  { label: 'Inter', value: "'Inter', 'Segoe UI', sans-serif" },
  { label: 'Noto Sans JP', value: "'Noto Sans JP', 'Yu Gothic UI', sans-serif" }
];

const EDITOR_FONT_PRESETS = [
  { label: 'Cascadia Code', value: "'Cascadia Code', 'Consolas', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', 'Consolas', monospace" },
  { label: 'Fira Code', value: "'Fira Code', 'Consolas', monospace" },
  { label: 'Consolas', value: "Consolas, 'Courier New', monospace" }
];

const DENSITY_OPTIONS: { value: Density; label: string; desc: string }[] = [
  { value: 'compact', label: 'Compact', desc: '14"以下の画面向け、余白小' },
  { value: 'normal', label: 'Normal', desc: '既定' },
  { value: 'comfortable', label: 'Comfortable', desc: '大画面向け、ゆったり' }
];

export function SettingsModal({
  open,
  initial,
  onClose,
  onApply,
  onReset
}: SettingsModalProps): JSX.Element | null {
  const [draft, setDraft] = useState<AppSettings>(initial);

  // モーダルを開いた瞬間に最新の initial で draft を初期化
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  if (!open) return null;

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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>設定</h2>
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
          {/* テーマ */}
          <section className="modal__section">
            <h3>テーマ</h3>
            <div className="modal__theme-grid">
              {THEME_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`theme-card ${draft.theme === opt.value ? 'is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={opt.value}
                    checked={draft.theme === opt.value}
                    onChange={() => update('theme', opt.value)}
                  />
                  <div className={`theme-card__preview theme-preview--${opt.value}`}>
                    <div className="theme-preview__sidebar" />
                    <div className="theme-preview__main">
                      <div className="theme-preview__bar" />
                      <div className="theme-preview__content" />
                    </div>
                  </div>
                  <div className="theme-card__meta">
                    <strong>{opt.label}</strong>
                    <span>{opt.desc}</span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* UIフォント */}
          <section className="modal__section">
            <h3>UI フォント</h3>
            <div className="modal__row">
              <label className="modal__label">
                <span>フォントファミリ</span>
                <select
                  value={
                    UI_FONT_PRESETS.find((p) => p.value === draft.uiFontFamily)?.value ??
                    '__custom__'
                  }
                  onChange={(e) => {
                    if (e.target.value !== '__custom__') {
                      update('uiFontFamily', e.target.value);
                    }
                  }}
                >
                  {UI_FONT_PRESETS.map((p) => (
                    <option key={p.label} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  <option value="__custom__">（カスタム）</option>
                </select>
              </label>
              <label className="modal__label">
                <span>サイズ (px)</span>
                <input
                  type="number"
                  min={10}
                  max={24}
                  value={draft.uiFontSize}
                  onChange={(e) => update('uiFontSize', Number(e.target.value) || 13)}
                />
              </label>
            </div>
            <label className="modal__label modal__label--full">
              <span>カスタム CSS font-family</span>
              <input
                type="text"
                value={draft.uiFontFamily}
                onChange={(e) => update('uiFontFamily', e.target.value)}
                spellCheck={false}
              />
            </label>
          </section>

          {/* エディタフォント */}
          <section className="modal__section">
            <h3>エディタフォント (Monaco)</h3>
            <div className="modal__row">
              <label className="modal__label">
                <span>フォントファミリ</span>
                <select
                  value={
                    EDITOR_FONT_PRESETS.find((p) => p.value === draft.editorFontFamily)
                      ?.value ?? '__custom__'
                  }
                  onChange={(e) => {
                    if (e.target.value !== '__custom__') {
                      update('editorFontFamily', e.target.value);
                    }
                  }}
                >
                  {EDITOR_FONT_PRESETS.map((p) => (
                    <option key={p.label} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  <option value="__custom__">（カスタム）</option>
                </select>
              </label>
              <label className="modal__label">
                <span>サイズ (px)</span>
                <input
                  type="number"
                  min={10}
                  max={24}
                  value={draft.editorFontSize}
                  onChange={(e) => update('editorFontSize', Number(e.target.value) || 13)}
                />
              </label>
            </div>
            <label className="modal__label modal__label--full">
              <span>カスタム CSS font-family</span>
              <input
                type="text"
                value={draft.editorFontFamily}
                onChange={(e) => update('editorFontFamily', e.target.value)}
                spellCheck={false}
              />
            </label>
          </section>

          {/* ターミナル */}
          <section className="modal__section">
            <h3>ターミナル</h3>
            <div className="modal__row">
              <label className="modal__label">
                <span>フォントサイズ (px)</span>
                <input
                  type="number"
                  min={10}
                  max={24}
                  value={draft.terminalFontSize}
                  onChange={(e) => update('terminalFontSize', Number(e.target.value) || 13)}
                />
              </label>
            </div>
            <p className="modal__note">
              ターミナルフォントファミリはエディタフォントと同じものを使用します。
            </p>
          </section>

          {/* 情報密度 */}
          <section className="modal__section">
            <h3>情報密度</h3>
            <div className="density-grid">
              {DENSITY_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`density-card ${draft.density === opt.value ? 'is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="density"
                    value={opt.value}
                    checked={draft.density === opt.value}
                    onChange={() => update('density', opt.value)}
                  />
                  <strong>{opt.label}</strong>
                  <span>{opt.desc}</span>
                </label>
              ))}
            </div>
          </section>

          {/* 保存動作 */}
          <section className="modal__section">
            <h3>保存動作</h3>
            <label className="modal__checkbox">
              <input
                type="checkbox"
                checked={draft.autoSave}
                onChange={(e) => update('autoSave', e.target.checked)}
              />
              <span>CLAUDE.md の自動保存を有効にする</span>
            </label>
            {draft.autoSave && (
              <label className="modal__label modal__label--full">
                <span>自動保存の間隔（秒）</span>
                <input
                  type="number"
                  min={5}
                  max={600}
                  step={5}
                  value={Math.round(draft.autoSaveIntervalMs / 1000)}
                  onChange={(e) =>
                    update('autoSaveIntervalMs', (Number(e.target.value) || 30) * 1000)
                  }
                />
              </label>
            )}
          </section>

          {/* Claude Code 起動オプション */}
          <section className="modal__section">
            <h3>Claude Code 起動オプション</h3>
            <label className="modal__label modal__label--full">
              <span>コマンド</span>
              <input
                type="text"
                value={draft.claudeCommand}
                onChange={(e) => update('claudeCommand', e.target.value)}
                placeholder="claude"
                spellCheck={false}
              />
            </label>
            <label className="modal__label modal__label--full">
              <span>引数（空白区切り、ダブルクォートで空白を含む値）</span>
              <input
                type="text"
                value={draft.claudeArgs}
                onChange={(e) => update('claudeArgs', e.target.value)}
                placeholder='--model opus --add-dir "D:/other project"'
                spellCheck={false}
              />
            </label>
            <label className="modal__label modal__label--full">
              <span>作業ディレクトリ（空なら現在のプロジェクトルート）</span>
              <input
                type="text"
                value={draft.claudeCwd}
                onChange={(e) => update('claudeCwd', e.target.value)}
                placeholder="（未設定）"
                spellCheck={false}
              />
            </label>
            <p className="modal__note">
              変更後は右パネルの「再起動」ボタンでターミナルを再起動すると反映されます。
            </p>
          </section>
        </div>

        <footer className="modal__footer">
          <button type="button" className="toolbar__btn" onClick={handleReset}>
            デフォルトに戻す
          </button>
          <div className="modal__footer-right">
            <button type="button" className="toolbar__btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="toolbar__btn toolbar__btn--primary"
              onClick={handleApply}
            >
              適用して保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
