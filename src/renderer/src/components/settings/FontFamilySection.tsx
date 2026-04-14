import type { AppSettings } from '../../../../types/shared';
import type { NumberSettingKey, StringSettingKey, UpdateSetting } from './types';

interface Props {
  title: string;
  familyKey: StringSettingKey;
  sizeKey: NumberSettingKey;
  presets: { label: string; value: string }[];
  draft: AppSettings;
  update: UpdateSetting;
}

/**
 * UI フォントとエディタフォント（および将来的に増えるフォント設定）を 1 つの
 * コンポーネントで扱えるよう、対象のキーを props で受け取る汎用セクション。
 */
export function FontFamilySection({
  title,
  familyKey,
  sizeKey,
  presets,
  draft,
  update
}: Props): JSX.Element {
  const family = draft[familyKey];
  const size = draft[sizeKey];
  const selectedPreset = presets.find((p) => p.value === family)?.value ?? '__custom__';

  return (
    <section className="modal__section">
      <h3>{title}</h3>
      <div className="modal__row">
        <label className="modal__label">
          <span>フォントファミリ</span>
          <select
            value={selectedPreset}
            onChange={(e) => {
              if (e.target.value !== '__custom__') {
                update(familyKey, e.target.value);
              }
            }}
          >
            {presets.map((p) => (
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
            value={size}
            onChange={(e) => update(sizeKey, Number(e.target.value) || 13)}
          />
        </label>
      </div>
      <label className="modal__label modal__label--full">
        <span>カスタム CSS font-family</span>
        <input
          type="text"
          value={family}
          onChange={(e) => update(familyKey, e.target.value)}
          spellCheck={false}
        />
      </label>
    </section>
  );
}
