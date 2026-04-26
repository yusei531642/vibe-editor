import type { AppSettings } from '../../../../types/shared';
import { TERMINAL_FONT_PRESETS } from '../../lib/settings-options';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function TerminalSection({ draft, update }: Props): JSX.Element {
  const currentFamily = draft.terminalFontFamily || draft.editorFontFamily;
  return (
    <section className="modal__section">
      <h3>ターミナル</h3>
      <div className="modal__row">
        <label className="modal__label">
          <span>フォント</span>
          <select
            value={currentFamily}
            onChange={(e) => {
              // Issue #165: 空文字選択で xterm が既定 monospace にフォールバックする事故を防ぐ。
              const v = e.target.value;
              if (v.trim() === '') return;
              update('terminalFontFamily', v);
            }}
            style={{ fontFamily: currentFamily }}
          >
            {TERMINAL_FONT_PRESETS.map((p) => (
              <option key={p.value} value={p.value} style={{ fontFamily: p.value }}>
                {p.label}
              </option>
            ))}
            {/* カスタム値 (preset 外) を追加で表示する */}
            {!TERMINAL_FONT_PRESETS.some((p) => p.value === currentFamily) && (
              <option value={currentFamily}>{currentFamily}</option>
            )}
          </select>
        </label>
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
        ★ 印 (JetBrains Mono) はアプリ内蔵フォント。OS にインストール済みでなくても綺麗に表示されます。
      </p>
    </section>
  );
}
