// tauri-api/handoffs.ts — handoffs.* IPC namespace (Phase 5 / Issue #373)
//
// Issue #737: Rust 側 `handoffs_*` は `CommandResult<T>` (= `Result<T, CommandError>`) を
// 返すため、reject を共通 `CommandError` に正規化する `invokeCommand` 経由で呼ぶ。

import type {
  HandoffCheckpoint,
  HandoffCreateRequest,
  HandoffCreateResult,
  HandoffMutationResult
} from '../../../../types/shared';
import { invokeCommand } from './command-error';

export const handoffs = {
  create: (request: HandoffCreateRequest): Promise<HandoffCreateResult> =>
    invokeCommand('handoffs_create', { req: request }),
  list: (projectRoot: string, teamId?: string | null): Promise<HandoffCheckpoint[]> =>
    invokeCommand('handoffs_list', { projectRoot, teamId }),
  read: (
    projectRoot: string,
    teamId: string | null | undefined,
    handoffId: string
  ): Promise<HandoffCheckpoint | null> =>
    invokeCommand('handoffs_read', { projectRoot, teamId, handoffId }),
  updateStatus: (
    projectRoot: string,
    teamId: string | null | undefined,
    handoffId: string,
    status: string,
    toAgentId?: string | null
  ): Promise<HandoffMutationResult> =>
    invokeCommand('handoffs_update_status', {
      projectRoot,
      teamId,
      handoffId,
      status,
      toAgentId
    })
};
