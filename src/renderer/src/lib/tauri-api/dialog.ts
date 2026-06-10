// tauri-api/dialog.ts — dialog.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type { DialogFileFilter } from '../../../../types/shared';

export const dialog = {
  openFolder: (title?: string): Promise<string | null> =>
    invoke('dialog_open_folder', { title }),
  // Issue #820: filters で拡張子を絞り込めるようにする (省略時は従来通り全ファイル)
  openFile: (title?: string, filters?: DialogFileFilter[]): Promise<string | null> =>
    invoke('dialog_open_file', { title, filters }),
  isFolderEmpty: (folderPath: string): Promise<boolean> =>
    invoke('dialog_is_folder_empty', { folderPath })
};
