/**
 * editor-card-dirty-registry の単体テスト (Issue #595)。
 *
 * - register / unregister の lifecycle
 * - 同 id の上書き
 * - getDirtyEditorCardSnapshots(undefined) と (ids) の両ルートで dirty のみ拾うこと
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetEditorCardDirtyRegistry,
  getDirtyEditorCardSnapshots,
  getEditorCardDirtySnapshot,
  registerEditorCardDirty
} from '../editor-card-dirty-registry';

afterEach(() => {
  __resetEditorCardDirtyRegistry();
});

describe('editor-card-dirty-registry', () => {
  it('register / unregister の lifecycle', () => {
    const unreg = registerEditorCardDirty('e1', () => ({ relPath: 'a.ts', isDirty: true }));
    expect(getEditorCardDirtySnapshot('e1')).toEqual({ relPath: 'a.ts', isDirty: true });
    unreg();
    expect(getEditorCardDirtySnapshot('e1')).toBeNull();
  });

  it('snapshot は呼び出し時点で評価される (closure 経由で最新値を返す)', () => {
    let dirty = false;
    registerEditorCardDirty('e1', () => ({ relPath: 'a.ts', isDirty: dirty }));
    expect(getEditorCardDirtySnapshot('e1')).toEqual({ relPath: 'a.ts', isDirty: false });
    dirty = true;
    expect(getEditorCardDirtySnapshot('e1')).toEqual({ relPath: 'a.ts', isDirty: true });
  });

  it('同 id を再 register すると後発が勝ち、cleanup は古い provider を削除しない', () => {
    const unreg1 = registerEditorCardDirty('e1', () => ({ relPath: 'old.ts', isDirty: true }));
    registerEditorCardDirty('e1', () => ({ relPath: 'new.ts', isDirty: true }));
    expect(getEditorCardDirtySnapshot('e1')?.relPath).toBe('new.ts');
    // 旧 unreg は新しい provider を巻き込まない
    unreg1();
    expect(getEditorCardDirtySnapshot('e1')?.relPath).toBe('new.ts');
  });

  it('getDirtyEditorCardSnapshots(undefined) は登録順で dirty のみ返す', () => {
    registerEditorCardDirty('e1', () => ({ relPath: 'a.ts', isDirty: true }));
    registerEditorCardDirty('e2', () => ({ relPath: 'b.ts', isDirty: false }));
    registerEditorCardDirty('e3', () => ({ relPath: 'c.ts', isDirty: true }));
    expect(getDirtyEditorCardSnapshots()).toEqual([
      { id: 'e1', relPath: 'a.ts' },
      { id: 'e3', relPath: 'c.ts' }
    ]);
  });

  it('getDirtyEditorCardSnapshots(ids) は ids の順序を尊重し、未登録 id は無視する', () => {
    registerEditorCardDirty('e1', () => ({ relPath: 'a.ts', isDirty: true }));
    registerEditorCardDirty('e2', () => ({ relPath: 'b.ts', isDirty: true }));
    registerEditorCardDirty('e3', () => ({ relPath: 'c.ts', isDirty: false }));
    const out = getDirtyEditorCardSnapshots(['unknown', 'e2', 'e1', 'e3']);
    expect(out).toEqual([
      { id: 'e2', relPath: 'b.ts' },
      { id: 'e1', relPath: 'a.ts' }
    ]);
  });

  it('Set<string> も Iterable として受け付ける', () => {
    registerEditorCardDirty('e1', () => ({ relPath: 'a.ts', isDirty: true }));
    registerEditorCardDirty('e2', () => ({ relPath: 'b.ts', isDirty: false }));
    const ids = new Set(['e1', 'e2']);
    const out = getDirtyEditorCardSnapshots(ids);
    expect(out).toEqual([{ id: 'e1', relPath: 'a.ts' }]);
  });
});
