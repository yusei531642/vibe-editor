// tauri-api/logs.ts — logs.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { ReadLogTailResponse } from '../../../../types/shared';

/** Issue #326: 設定モーダルからログを表示する用。
 *  Rust 側で stderr と並行して `~/.vibe-editor/logs/vibe-editor.log` に書き出している。 */
export const logs = {
  /** ログファイル末尾の最大 maxBytes バイトを返す。省略時は 256KB。 */
  readTail: (maxBytes?: number): Promise<ReadLogTailResponse> =>
    invoke('logs_read_tail', { maxBytes }),
  /** ログ格納ディレクトリを OS のファイルマネージャで開く。 */
  openDir: (): Promise<void> => invoke('logs_open_dir')
};
