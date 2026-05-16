// tauri-api/role-profiles.ts — roleProfiles.* IPC namespace (Phase 5 / Issue #373)
//
// Issue #737: `role_profiles_save` は `CommandResult<()>` を返すため `invokeCommand` 経由で
// 呼び、reject を共通 `CommandError` に正規化する。`role_profiles_load` は失敗を `Err` では
// なく fallback 値で表現する command なので素の `invoke` のまま。

import { invoke } from '@tauri-apps/api/core';
import type { RoleProfilesFile } from '../../../../types/shared';
import { invokeCommand } from './command-error';

export const roleProfiles = {
  load: (): Promise<RoleProfilesFile | null> => invoke('role_profiles_load'),
  save: (file: RoleProfilesFile): Promise<void> =>
    invokeCommand('role_profiles_save', { file })
};
