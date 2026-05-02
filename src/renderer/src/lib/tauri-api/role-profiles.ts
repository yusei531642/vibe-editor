// tauri-api/role-profiles.ts — roleProfiles.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { RoleProfilesFile } from '../../../../types/shared';

export const roleProfiles = {
  load: (): Promise<RoleProfilesFile | null> => invoke('role_profiles_load'),
  save: (file: RoleProfilesFile): Promise<void> => invoke('role_profiles_save', { file })
};
