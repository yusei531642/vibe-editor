// tauri-api/git.ts — git.* IPC namespace (Phase 5 / Issue #373)

import { invokeCommand } from './command-error';
import type { GitDiffResult, GitStatus } from '../../../../types/shared';

export const git = {
  status: (projectRoot: string): Promise<GitStatus> => invokeCommand('git_status', { projectRoot }),
  diff: (
    projectRoot: string,
    relPath: string,
    originalRelPath?: string
  ): Promise<GitDiffResult> =>
    invokeCommand('git_diff', { projectRoot, relPath, originalRelPath })
};
