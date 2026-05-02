// tauri-api/sessions.ts — sessions.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { SessionInfo } from '../../../../types/shared';

export const sessions = {
  list: (projectRoot: string): Promise<SessionInfo[]> =>
    invoke('sessions_list', { projectRoot })
};
