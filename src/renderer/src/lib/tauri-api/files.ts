// tauri-api/files.ts — files.* IPC namespace (Phase 5 / Issue #373)

import { invoke } from '@tauri-apps/api/core';
import type {
  FileListResult,
  FileReadResult,
  FileWriteResult
} from '../../../../types/shared';

export const files = {
  list: (projectRoot: string, relPath: string): Promise<FileListResult> =>
    invoke('files_list', { projectRoot, relPath }),
  read: (projectRoot: string, relPath: string): Promise<FileReadResult> =>
    invoke('files_read', { projectRoot, relPath }),
  /**
   * Issue #65 / #104 / #102 / #119: external-change 検出と元 encoding の保持。
   *   - expectedMtimeMs: 開いた時点の mtime
   *   - expectedSizeBytes: 開いた時点の size (mtime 解像度の補完)
   *   - encoding: 開いたときに検出した encoding。指定するとその encoding で再エンコードされる
   *   - expectedContentHash: 開いた時点の SHA-256 (hex)。同サイズかつ 1 秒以内の編集が
   *     mtime/size 両方で見逃されるケースを内容ハッシュで補完検出する。
   */
  write: (
    projectRoot: string,
    relPath: string,
    content: string,
    expectedMtimeMs?: number,
    expectedSizeBytes?: number,
    encoding?: string,
    expectedContentHash?: string
  ): Promise<FileWriteResult> =>
    invoke('files_write', {
      projectRoot,
      relPath,
      content,
      expectedMtimeMs,
      expectedSizeBytes,
      encoding,
      expectedContentHash
    })
};
