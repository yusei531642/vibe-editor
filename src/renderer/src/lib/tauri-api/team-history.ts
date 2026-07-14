// tauri-api/team-history.ts — teamHistory.* IPC namespace (Phase 5 / Issue #373)

import { CommandError, invokeCommand } from './command-error';
import type { TeamHistoryEntry } from '../../../../types/shared';

export interface MutationResult {
  ok: boolean;
  error?: string;
  /**
   * Issue #1194: 失敗の machine-readable 分類 (`authz` / `validation` 等)。Rust 側の
   * 構造化 CommandError から wrapper が引き写す renderer 専用フィールドで、成功時と
   * 非構造化エラー時は undefined。
   */
  code?: string;
  /**
   * Issue #642: 保存直前に Rust 側が disk 上の `team-history.json` の外部変更
   * (手編集 / 別 vibe-editor インスタンス) を検知し、merge してから書き戻したかどうか。
   * このフラグが true のとき renderer は list 再取得 + toast 通知などで
   * 「外部変更を取り込んだ」事実をユーザーに伝えるべき。false のときは Rust 側が
   * このフィールドを serialize しないので undefined になる (= 通常の正常 save)。
   */
  externalChangeMerged?: boolean;
}

/**
 * Issue #1194: mutation 系は Rust 側が `CommandResult<MutationResult>` を返す
 * (authz 拒否は構造化 CommandError で reject)。既存 caller は「resolve した
 * MutationResult の ok / error を見る」契約なので、reject を失敗 MutationResult に
 * 正規化して契約を維持する。
 */
const toMutationFailure = (error: unknown): MutationResult => {
  if (error instanceof CommandError) {
    return { ok: false, error: error.message, code: error.code ?? undefined };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
};

export const teamHistory = {
  list: (projectRoot: string): Promise<TeamHistoryEntry[]> =>
    invokeCommand('team_history_list', { projectRoot }),
  save: (entry: TeamHistoryEntry): Promise<MutationResult> =>
    invokeCommand<MutationResult>('team_history_save', { entry }).catch(toMutationFailure),
  /** Issue #132: 複数チームを 1 IPC + 1 disk write でまとめて保存する */
  saveBatch: (entries: TeamHistoryEntry[]): Promise<MutationResult> =>
    invokeCommand<MutationResult>('team_history_save_batch', { entries }).catch(
      toMutationFailure
    ),
  /** Issue #1194: 削除も active project の認可を通す (id 単独では他 project を触れない)。 */
  delete: (projectRoot: string, id: string): Promise<MutationResult> =>
    invokeCommand<MutationResult>('team_history_delete', { projectRoot, id }).catch(
      toMutationFailure
    )
};
