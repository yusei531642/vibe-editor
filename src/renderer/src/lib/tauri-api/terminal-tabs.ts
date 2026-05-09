// tauri-api/terminal-tabs.ts — Issue #661 IDE タブ永続化 IPC namespace
//
// `~/.vibe-editor/terminal-tabs.json` を Rust 側で atomic write する API のラッパ。
// 読込時は schemaVersion 不一致 / 未存在で `null` を返す (renderer は素の IDE 起動に
// フォールバックする)。

import { invoke } from '@tauri-apps/api/core';
import type { PersistedTerminalTabsFile } from '../../../../types/shared';

interface MutationResult {
  ok: boolean;
  error?: string;
}

export const terminalTabs = {
  /** 永続化ファイルを読む。未存在 / schemaVersion mismatch / parse 失敗で null。 */
  load: async (): Promise<PersistedTerminalTabsFile | null> => {
    const result = await invoke<PersistedTerminalTabsFile | null>('terminal_tabs_load');
    return result ?? null;
  },
  /** 全体を atomic 上書き。read-modify-write は呼び出し側責務。 */
  save: (file: PersistedTerminalTabsFile): Promise<MutationResult> =>
    invoke('terminal_tabs_save', { file }),
  /** ファイルを削除して cache を空に戻す。idempotent。 */
  clear: (): Promise<MutationResult> => invoke('terminal_tabs_clear')
};
