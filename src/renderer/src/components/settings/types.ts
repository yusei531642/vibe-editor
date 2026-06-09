import type { AppSettings } from '../../../../types/shared';

export type UpdateSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
) => void;

export type StringSettingKey = {
  [K in keyof AppSettings]-?: Extract<AppSettings[K], string> extends never ? never : K;
}[keyof AppSettings];

export type NumberSettingKey = {
  [K in keyof AppSettings]-?: Extract<AppSettings[K], number> extends never ? never : K;
}[keyof AppSettings];
