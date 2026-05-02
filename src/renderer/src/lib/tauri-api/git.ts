// tauri-api/git.ts — git.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { GitDiffResult, GitStatus } from '../../../../types/shared';

export const git = {
  status: (projectRoot: string): Promise<GitStatus> => invoke('git_status', { projectRoot }),
  diff: (
    projectRoot: string,
    relPath: string,
    originalRelPath?: string
  ): Promise<GitDiffResult> =>
    invoke('git_diff', { projectRoot, relPath, originalRelPath })
};
