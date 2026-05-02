// tauri-api/settings.ts — settings.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../../../../types/shared';

export const settings = {
  // 既定値とのマージや schemaVersion 判定は settings-migrate.ts に集約する。
  // ここで先に DEFAULT_SETTINGS を混ぜると、旧設定に現在の schemaVersion が
  // 入ってしまい、必要なマイグレーションがスキップされる。
  load: (): Promise<unknown> => invoke('settings_load'),
  save: (settings: AppSettings): Promise<void> => invoke('settings_save', { settings })
};
