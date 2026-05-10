// tauri-api/team-history.ts — teamHistory.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { TeamHistoryEntry } from '../../../../types/shared';

interface MutationResult {
  ok: boolean;
  error?: string;
  /**
   * Issue #642: 保存直前に Rust 側が disk 上の `team-history.json` の外部変更
   * (手編集 / 別 vibe-editor インスタンス) を検知し、merge してから書き戻したかどうか。
   * このフラグが true のとき renderer は list 再取得 + toast 通知などで
   * 「外部変更を取り込んだ」事実をユーザーに伝えるべき。false のときは Rust 側が
   * このフィールドを serialize しないので undefined になる (= 通常の正常 save)。
   */
  externalChangeMerged?: boolean;
}

export const teamHistory = {
  list: (projectRoot: string): Promise<TeamHistoryEntry[]> =>
    invoke('team_history_list', { projectRoot }),
  save: (entry: TeamHistoryEntry): Promise<MutationResult> =>
    invoke('team_history_save', { entry }),
  /** Issue #132: 複数チームを 1 IPC + 1 disk write でまとめて保存する */
  saveBatch: (entries: TeamHistoryEntry[]): Promise<MutationResult> =>
    invoke('team_history_save_batch', { entries }),
  delete: (id: string): Promise<MutationResult> => invoke('team_history_delete', { id })
};
