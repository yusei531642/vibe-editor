import type { FileReadResult } from '../../../../types/shared';
import type { EditorTab } from './use-file-tabs';

export interface EditorTabReadSnapshot {
  content: string;
  originalContent: string;
}

export function createLoadingEditorTab(
  id: string,
  rootPath: string,
  relPath: string
): EditorTab {
  return {
    id,
    rootPath,
    relPath,
    content: '',
    originalContent: '',
    isBinary: false,
    lossyEncoding: false,
    encoding: 'utf-8',
    loading: true,
    error: null,
    pinned: false
  };
}

function matchesReadSnapshot(tab: EditorTab, snapshot: EditorTabReadSnapshot): boolean {
  return (
    tab.content === snapshot.content && tab.originalContent === snapshot.originalContent
  );
}

export function applyEditorTabReadResult(
  tab: EditorTab,
  result: FileReadResult,
  lossyEncoding: boolean,
  snapshot: EditorTabReadSnapshot
): EditorTab {
  if (!matchesReadSnapshot(tab, snapshot)) return tab;
  if (!result.ok) {
    return { ...tab, loading: false, error: result.error ?? 'error' };
  }
  return {
    ...tab,
    loading: false,
    error: null,
    content: result.content,
    originalContent: result.content,
    isBinary: result.isBinary,
    lossyEncoding,
    encoding: result.encoding || 'utf-8',
    mtimeMs: result.mtimeMs,
    sizeBytes: result.sizeBytes,
    contentHash: result.contentHash
  };
}

export function applyEditorTabReadError(
  tab: EditorTab,
  error: unknown,
  snapshot: EditorTabReadSnapshot
): EditorTab {
  return matchesReadSnapshot(tab, snapshot)
    ? { ...tab, loading: false, error: String(error) }
    : tab;
}
