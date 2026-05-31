import type { AppSettings } from '../../../../types/shared';

export type UpdateSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
) => void;

// `-?` で optional 修飾子を除去しないと、homomorphic mapped type が optional
// プロパティ (例: terminalFontFamily?: string) に対して `never | undefined` を
// 生成し、結果のキー union に `undefined` が漏れて TS2538 / TS2345 を招く。
// `NonNullable<AppSettings[K]>` で値の string/number 判定からも undefined を外す。
export type StringSettingKey = NonNullable<
  {
    [K in keyof AppSettings]-?: NonNullable<AppSettings[K]> extends string ? K : never;
  }[keyof AppSettings]
>;

export type NumberSettingKey = NonNullable<
  {
    [K in keyof AppSettings]-?: NonNullable<AppSettings[K]> extends number ? K : never;
  }[keyof AppSettings]
>;
