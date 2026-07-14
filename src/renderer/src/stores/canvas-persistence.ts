import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { CanvasState } from './canvas';
import {
  toPersistedCanvasState,
  type PersistedCardNode
} from './canvas-card-identity';

export const CANVAS_PERSIST_NAME = 'vibe-editor:canvas';
export const CANVAS_PERSIST_VERSION = 6;
export const CANVAS_CORRUPT_BACKUP_PREFIX = `${CANVAS_PERSIST_NAME}:corrupt-backup:`;
const CANVAS_RECOVERY_NOTICE_KEY = `${CANVAS_PERSIST_NAME}:recovery-notice`;

export interface CanvasRecoveryNotice {
  backupKey: string | null;
}

let pendingRecoveryNotice: CanvasRecoveryNotice | null = null;
const writeBlockedKeys = new Set<string>();

type CanvasPersistState = Pick<
  CanvasState,
  'viewport' | 'stageView' | 'teamLocks' | 'arrangeGap'
> & { nodes: PersistedCardNode[] };

function canvasStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const canvasPersistStorage: PersistStorage<CanvasPersistState> = {
  getItem: (name) => {
    const storage = canvasStorage();
    const raw = storage?.getItem(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StorageValue<CanvasPersistState>;
    } catch (error) {
      const backupKey = `${CANVAS_CORRUPT_BACKUP_PREFIX}${Date.now()}`;
      try {
        storage?.setItem(backupKey, raw);
        storage?.setItem(
          CANVAS_RECOVERY_NOTICE_KEY,
          JSON.stringify({ backupKey } satisfies CanvasRecoveryNotice)
        );
        storage?.removeItem(name);
        writeBlockedKeys.delete(name);
        pendingRecoveryNotice = { backupKey };
      } catch (backupError) {
        writeBlockedKeys.add(name);
        pendingRecoveryNotice = { backupKey: null };
        console.error('[canvas-persistence] corrupt data backup failed:', backupError);
      }
      console.error('[canvas-persistence] corrupt data detected:', error);
      return null;
    }
  },
  setItem: (name, value) => {
    // Issue #864/#835: drag 中は nodes が毎フレーム変わるため、localStorage への
    // JSON.stringify が UI スレッドを詰まらせる。drag 終了時に明示 flush する。
    if (canvasPersistPaused()) return;
    if (writeBlockedKeys.has(name)) return;
    canvasStorage()?.setItem(name, JSON.stringify(value));
  },
  removeItem: (name) => {
    writeBlockedKeys.delete(name);
    canvasStorage()?.removeItem(name);
  }
};

export function takeCanvasRecoveryNotice(): CanvasRecoveryNotice | null {
  if (pendingRecoveryNotice) {
    const notice = pendingRecoveryNotice;
    pendingRecoveryNotice = null;
    canvasStorage()?.removeItem(CANVAS_RECOVERY_NOTICE_KEY);
    return notice;
  }
  const storage = canvasStorage();
  const raw = storage?.getItem(CANVAS_RECOVERY_NOTICE_KEY);
  if (!raw) return null;
  storage?.removeItem(CANVAS_RECOVERY_NOTICE_KEY);
  try {
    return JSON.parse(raw) as CanvasRecoveryNotice;
  } catch {
    return null;
  }
}

let isPaused = false;

export function setCanvasPersistPaused(paused: boolean): void {
  isPaused = paused;
}

export function canvasPersistPaused(): boolean {
  return isPaused;
}

export function toCanvasPersistState(state: CanvasState): CanvasPersistState {
  return {
    ...toPersistedCanvasState(state)
  };
}

export function flushCanvasPersistState(state: CanvasState): void {
  canvasPersistStorage.setItem(CANVAS_PERSIST_NAME, {
    state: toCanvasPersistState(state),
    version: CANVAS_PERSIST_VERSION
  });
}
