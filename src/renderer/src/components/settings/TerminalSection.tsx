import type { AppSettings } from '../../../../types/shared';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function TerminalSection({ draft, update }: Props): JSX.Element {
  return (
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
  );
}
