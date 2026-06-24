import type { Language } from '../../../../types/shared';

import { canvasEn, canvasJa } from './canvas';
import { commonEn, commonJa } from './common';
import { gitEn, gitJa } from './git';
import { runtimeEn, runtimeJa } from './runtime';
import { settingsEn, settingsJa } from './settings';
import { teamEn, teamJa } from './team';

export type Dict = Record<string, string>;

export const ja: Dict = {
  ...commonJa,
  ...runtimeJa,
  ...gitJa,
  ...canvasJa,
  ...teamJa,
  ...settingsJa
};

export const en: Dict = {
  ...commonEn,
  ...runtimeEn,
  ...gitEn,
  ...canvasEn,
  ...teamEn,
  ...settingsEn
};

export const translations: Record<Language, Dict> = { ja, en };
