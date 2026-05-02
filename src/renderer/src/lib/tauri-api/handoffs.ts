// tauri-api/handoffs.ts — handoffs.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type {
  HandoffCheckpoint,
  HandoffCreateRequest,
  HandoffCreateResult,
  HandoffMutationResult
} from '../../../../types/shared';

export const handoffs = {
  create: (request: HandoffCreateRequest): Promise<HandoffCreateResult> =>
    invoke('handoffs_create', { req: request }),
  list: (projectRoot: string, teamId?: string | null): Promise<HandoffCheckpoint[]> =>
    invoke('handoffs_list', { projectRoot, teamId }),
  read: (
    projectRoot: string,
    teamId: string | null | undefined,
    handoffId: string
  ): Promise<HandoffCheckpoint | null> =>
    invoke('handoffs_read', { projectRoot, teamId, handoffId }),
  updateStatus: (
    projectRoot: string,
    teamId: string | null | undefined,
    handoffId: string,
    status: string,
    toAgentId?: string | null
  ): Promise<HandoffMutationResult> =>
    invoke('handoffs_update_status', { projectRoot, teamId, handoffId, status, toAgentId })
};
