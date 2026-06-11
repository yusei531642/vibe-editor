// tauri-api/sessions.ts — sessions.* IPC namespace (Phase 5 / Issue #373)

import { invokeCommand } from './command-error';
import type { SessionInfo } from '../../../../types/shared';

export const sessions = {
  list: (projectRoot: string): Promise<SessionInfo[]> =>
    invokeCommand('sessions_list', { projectRoot })
};
