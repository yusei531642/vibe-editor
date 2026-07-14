import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_CORRUPT_BACKUP_PREFIX,
  CANVAS_PERSIST_NAME,
  canvasPersistStorage,
  takeCanvasRecoveryNotice
} from '../canvas-persistence';

describe('Canvas corrupt persistence recovery (Issue #1140)', () => {
  beforeEach(() => {
    localStorage.clear();
    canvasPersistStorage.removeItem(CANVAS_PERSIST_NAME);
    takeCanvasRecoveryNotice();
    vi.restoreAllMocks();
  });

  it('backs up invalid JSON byte-for-byte before clearing the live key', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_721_000_000_000);
    const corrupt = '{"state":{"nodes":[';
    localStorage.setItem(CANVAS_PERSIST_NAME, corrupt);

    expect(canvasPersistStorage.getItem(CANVAS_PERSIST_NAME)).toBeNull();

    const backupKey = `${CANVAS_CORRUPT_BACKUP_PREFIX}1721000000000`;
    expect(localStorage.getItem(backupKey)).toBe(corrupt);
    expect(localStorage.getItem(CANVAS_PERSIST_NAME)).toBeNull();
    expect(takeCanvasRecoveryNotice()).toEqual({ backupKey });
    expect(takeCanvasRecoveryNotice()).toBeNull();
  });

  it('blocks empty-state writes when the corrupt payload cannot be backed up', () => {
    const corrupt = '{not-json';
    localStorage.setItem(CANVAS_PERSIST_NAME, corrupt);
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (String(key).startsWith(CANVAS_CORRUPT_BACKUP_PREFIX)) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });

    expect(canvasPersistStorage.getItem(CANVAS_PERSIST_NAME)).toBeNull();
    canvasPersistStorage.setItem(CANVAS_PERSIST_NAME, {
      state: {} as never,
      version: 6
    });

    expect(localStorage.getItem(CANVAS_PERSIST_NAME)).toBe(corrupt);
    expect(takeCanvasRecoveryNotice()).toEqual({ backupKey: null });
  });
});
