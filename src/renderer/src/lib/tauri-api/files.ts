// tauri-api/files.ts — files.* IPC namespace (Phase 5 / Issue #373)

import { invokeCommand } from './command-error';
import type {
  FileListResult,
  FileImageReadResult,
  FileMutationResult,
  FileReadResult,
  FileWriteResult
} from '../../../../types/shared';

export const files = {
  list: (projectRoot: string, relPath: string): Promise<FileListResult> =>
    invokeCommand('files_list', { projectRoot, relPath }),
  read: (projectRoot: string, relPath: string): Promise<FileReadResult> =>
    invokeCommand('files_read', { projectRoot, relPath }),
  /** Issue #1193: global asset:// scopeを使わずbackend認可済みdata URLを取得する。 */
  readImage: (projectRoot: string, relPath: string): Promise<FileImageReadResult> =>
    invokeCommand('files_read_image', { projectRoot, relPath }),
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
    invokeCommand('files_write', {
      projectRoot,
      relPath,
      content,
      expectedMtimeMs,
      expectedSizeBytes,
      encoding,
      expectedContentHash
    }),
  /**
   * Issue #592: 親ディレクトリ relPath 配下に空ファイル `name` を作成する。
   * `relPath = ""` でルート直下。`overwrite` 既定 false で既存ファイルがあれば失敗。
   */
  create: (
    projectRoot: string,
    relPath: string,
    name: string,
    overwrite?: boolean
  ): Promise<FileMutationResult> =>
    invokeCommand('files_create', { projectRoot, relPath, name, overwrite }),
  /** Issue #592: 親ディレクトリ relPath 配下に新規ディレクトリ `name` を作る。 */
  createDir: (projectRoot: string, relPath: string, name: string): Promise<FileMutationResult> =>
    invokeCommand('files_create_dir', { projectRoot, relPath, name }),
  /**
   * Issue #592: ファイル/ディレクトリを rename もしくは同一ルート内移動する。
   * `fromRel` は既存パス、`toParentRel` は移動先親ディレクトリ、`newName` は新しい basename。
   * `overwrite` を true にすると既存パスを上書きする (cut & paste の上書き経路)。
   */
  rename: (
    projectRoot: string,
    fromRel: string,
    toParentRel: string,
    newName: string,
    overwrite?: boolean
  ): Promise<FileMutationResult> =>
    invokeCommand('files_rename', { projectRoot, fromRel, toParentRel, newName, overwrite }),
  /**
   * Issue #592: ファイル/ディレクトリを削除する。
   * `permanent=false` (default) なら OS のゴミ箱、`true` なら完全削除。
   */
  delete: (
    projectRoot: string,
    relPath: string,
    permanent?: boolean
  ): Promise<FileMutationResult> =>
    invokeCommand('files_delete', { projectRoot, relPath, permanent }),
  /**
   * Issue #592: ファイル/ディレクトリを再帰コピー。Cut/Copy & Paste の Copy 経路。
   * cut の場合は呼び出し側で `rename` を使う。
   */
  copy: (
    projectRoot: string,
    fromRel: string,
    toParentRel: string,
    newName: string,
    overwrite?: boolean
  ): Promise<FileMutationResult> =>
    invokeCommand('files_copy', { projectRoot, fromRel, toParentRel, newName, overwrite })
};
