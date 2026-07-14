// tauri-api/settings.ts — settings.* IPC namespace (Phase 5 / Issue #373)

import { invokeCommand } from './command-error';
import type { AppSettings } from '../../../../types/shared';

export const settings = {
  // 既定値とのマージや schemaVersion 判定は settings-migrate.ts に集約する。
  // ここで先に DEFAULT_SETTINGS を混ぜると、旧設定に現在の schemaVersion が
  // 入ってしまい、必要なマイグレーションがスキップされる。
  load: (): Promise<unknown> => invokeCommand('settings_load'),
  save: (settings: AppSettings): Promise<void> => invokeCommand('settings_save', { settings }),
  pickCustomMascot: (title?: string): Promise<string | null> =>
    invokeCommand('settings_pick_custom_mascot', { title: title ?? null }),
  loadCustomMascot: (): Promise<string | null> =>
    invokeCommand('settings_load_custom_mascot'),
  clearCustomMascot: (): Promise<void> =>
    invokeCommand('settings_clear_custom_mascot')
};
