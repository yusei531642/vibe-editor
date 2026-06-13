import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { CanvasState } from './canvas';
import {
  toPersistedCanvasState,
  type PersistedCardNode
} from './canvas-card-identity';

export const CANVAS_PERSIST_NAME = 'vibe-editor:canvas';
export const CANVAS_PERSIST_VERSION = 6;

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
    const raw = canvasStorage()?.getItem(name);
    if (!raw) return null;
    return JSON.parse(raw) as StorageValue<CanvasPersistState>;
  },
  setItem: (name, value) => {
    // Issue #864/#835: drag 中は nodes が毎フレーム変わるため、localStorage への
    // JSON.stringify が UI スレッドを詰まらせる。drag 終了時に明示 flush する。
    if (canvasPersistPaused()) return;
    canvasStorage()?.setItem(name, JSON.stringify(value));
  },
  removeItem: (name) => {
    canvasStorage()?.removeItem(name);
  }
};

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
