// tauri-api/terminal.ts — terminal.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import { subscribeEvent, subscribeEventReady } from '../subscribe-event';
import type {
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalExitInfo
} from '../../../../types/shared';

interface SavePastedImageResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export const terminal = {
  create: (opts: TerminalCreateOptions): Promise<TerminalCreateResult> =>
    invoke('terminal_create', { opts }),
  write: (id: string, data: string): Promise<void> =>
    invoke('terminal_write', { id, data }),
  resize: (id: string, cols: number, rows: number): Promise<void> =>
    invoke('terminal_resize', { id, cols, rows }),
  kill: (id: string): Promise<void> => invoke('terminal_kill', { id }),
  savePastedImage: (base64: string, mimeType: string): Promise<SavePastedImageResult> =>
    invoke('terminal_save_pasted_image', { base64, mimeType }),

  onData: (id: string, cb: (data: string) => void): (() => void) =>
    subscribeEvent<string>(`terminal:data:${id}`, cb),

  onExit: (id: string, cb: (info: TerminalExitInfo) => void): (() => void) =>
    subscribeEvent<TerminalExitInfo>(`terminal:exit:${id}`, cb),

  onSessionId: (id: string, cb: (sessionId: string) => void): (() => void) =>
    subscribeEvent<string>(`terminal:sessionId:${id}`, cb),

  /** Issue #285: pre-subscribe 用。`terminal.create` 前に await して使う。 */
  onDataReady: (id: string, cb: (data: string) => void): Promise<() => void> =>
    subscribeEventReady<string>(`terminal:data:${id}`, cb),

  onExitReady: (id: string, cb: (info: TerminalExitInfo) => void): Promise<() => void> =>
    subscribeEventReady<TerminalExitInfo>(`terminal:exit:${id}`, cb),

  onSessionIdReady: (id: string, cb: (sessionId: string) => void): Promise<() => void> =>
    subscribeEventReady<string>(`terminal:sessionId:${id}`, cb)
};
