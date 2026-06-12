// tauri-api/terminal-tabs.ts — Issue #661 IDE タブ永続化 IPC namespace
//
// `~/.vibe-editor/terminal-tabs.json` を Rust 側で atomic write する API のラッパ。
// 読込時は schemaVersion 不一致 / 未存在 / parse 失敗で `null` を返す (parse 失敗時の原本退避と
// save 前の未来 schema guard は Rust 側が担当する)。

import { invokeCommand } from './command-error';
import type {
  PersistedTerminalTabsFile,
  TerminalTabsLoadResult
} from '../../../../types/shared';

export interface MutationResult {
  ok: boolean;
  error?: string;
}

export const terminalTabs = {
  /**
   * 永続化ファイルを読む。未存在 / schemaVersion mismatch / parse 失敗で null。
   * parse 失敗時は Rust 側で timestamped backup を作る。
   *
   * Issue #857: 戻り値が `TerminalTabsLoadResult` (= `PersistedTerminalTabsFile` +
   * `droppedSessions`) になった。invoke 名は不変。
   */
  load: async (): Promise<TerminalTabsLoadResult | null> => {
    const result = await invokeCommand<TerminalTabsLoadResult | null>('terminal_tabs_load');
    return result ?? null;
  },
  /** 全体を atomic 上書き。read-modify-write は呼び出し側責務。失敗は ok=false で返る。 */
  save: (file: PersistedTerminalTabsFile): Promise<MutationResult> =>
    invokeCommand('terminal_tabs_save', { file }),
  /** ファイルを削除して cache を空に戻す。idempotent。 */
  clear: (): Promise<MutationResult> => invokeCommand('terminal_tabs_clear')
};
