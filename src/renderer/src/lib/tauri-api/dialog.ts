// tauri-api/dialog.ts — dialog.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';

export const dialog = {
  openFolder: (title?: string): Promise<string | null> =>
    invoke('dialog_open_folder', { title }),
  openFile: (title?: string): Promise<string | null> => invoke('dialog_open_file', { title }),
  isFolderEmpty: (folderPath: string): Promise<boolean> =>
    invoke('dialog_is_folder_empty', { folderPath })
};
