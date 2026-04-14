import type { AppSettings } from '../../../../types/shared';

export type UpdateSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
) => void;

export type StringSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends string ? K : never;
}[keyof AppSettings];

export type NumberSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends number ? K : never;
}[keyof AppSettings];
