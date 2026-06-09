import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';

const ARIA_LABEL_KEYS = [
  'editor.save.ariaLabel',
  'rail.primaryNav',
  'windowControls.group',
  'settings.sections.ariaLabel',
  'onboarding.ariaLabel',
  'onboarding.workspace.clear'
];

describe('i18n aria-label keys', () => {
  it('Issue #845 の aria-label 用キーを ja/en の両方で定義している', () => {
    for (const key of ARIA_LABEL_KEYS) {
      expect(translate('ja', key)).not.toBe(key);
      expect(translate('en', key)).not.toBe(key);
    }
  });
});
