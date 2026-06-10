// Issue #908: filetree の WAI-ARIA tree パターン (role / aria-* / roving tabindex /
// 矢印キー移動) の回帰テスト。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FileNode } from '../../../../types/shared';

vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string) => key
}));
vi.mock('../../lib/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() })
}));
vi.mock('../../lib/use-native-confirm', () => ({
  useNativeConfirm: () => vi.fn()
}));
vi.mock('../../lib/tauri-api', () => ({
  api: { files: {} }
}));

const hoisted = vi.hoisted(() => ({
  state: null as unknown as Record<string, unknown>
}));

vi.mock('../../lib/filetree-state-context', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/filetree-state-context')>();
  return {
    ...orig,
    useFileTreeState: () => hoisted.state
  };
});

import { dirKey, type DirState } from '../../lib/filetree-state-context';
import { FileTreePanel } from '../FileTreePanel';

const ROOT = '/proj';

const node = (name: string, path: string, isDir: boolean): FileNode => ({ name, path, isDir });

const dirState = (entries: FileNode[]): DirState => ({ loading: false, error: null, entries });

let toggleDir: ReturnType<typeof vi.fn>;

function setupState(): void {
  toggleDir = vi.fn();
  const dirs = new Map<string, DirState>([
    [dirKey(ROOT, ''), dirState([node('src', 'src', true), node('README.md', 'README.md', false)])],
    [dirKey(ROOT, 'src'), dirState([node('main.ts', 'src/main.ts', false)])]
  ]);
  hoisted.state = {
    expanded: new Set([dirKey(ROOT, 'src')]),
    collapsedRoots: new Set<string>(),
    dirs,
    toggleDir,
    toggleRoot: vi.fn(),
    loadDir: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn(),
    registerRoots: vi.fn(),
    unregisterRoots: vi.fn()
  };
}

function renderPanel(activeFilePath: string | null = 'README.md') {
  return render(
    <FileTreePanel
      primaryRoot={ROOT}
      extraRoots={[]}
      activeFilePath={activeFilePath}
      onOpenFile={vi.fn()}
      onAddWorkspaceFolder={vi.fn()}
      onRemoveWorkspaceFolder={vi.fn()}
    />
  );
}

beforeEach(() => {
  setupState();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileTreePanel ARIA tree (Issue #908)', () => {
  it('role=tree コンテナと role=treeitem の行が描画される', () => {
    renderPanel();
    expect(screen.getByRole('tree')).toBeInTheDocument();
    // src (dir, 展開済み) / src/main.ts / README.md の 3 行
    const items = screen.getAllByRole('treeitem');
    expect(items).toHaveLength(3);
  });

  it('ディレクトリ行に aria-expanded、ファイル行に aria-selected、全行に aria-level が付く', () => {
    renderPanel();
    const [srcRow, mainRow, readmeRow] = screen.getAllByRole('treeitem');
    expect(srcRow).toHaveAttribute('aria-expanded', 'true');
    expect(srcRow).toHaveAttribute('aria-level', '1');
    expect(srcRow).not.toHaveAttribute('aria-selected');
    expect(mainRow).toHaveAttribute('aria-level', '2');
    expect(mainRow).toHaveAttribute('aria-selected', 'false');
    expect(mainRow).not.toHaveAttribute('aria-expanded');
    expect(readmeRow).toHaveAttribute('aria-level', '1');
    expect(readmeRow).toHaveAttribute('aria-selected', 'true');
  });

  it('roving tabindex: tab stop は丁度 1 行で active 行が優先される', () => {
    renderPanel('README.md');
    const items = screen.getAllByRole('treeitem');
    const stops = items.filter((el) => el.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveTextContent('README.md');
  });

  it('ArrowDown / ArrowUp で前後の行へ focus が移り tab stop も移動する', () => {
    renderPanel();
    const [srcRow, mainRow] = screen.getAllByRole('treeitem');
    srcRow!.focus();
    fireEvent.keyDown(srcRow!, { key: 'ArrowDown' });
    expect(mainRow).toHaveFocus();
    expect(mainRow!.tabIndex).toBe(0);
    expect(srcRow!.tabIndex).toBe(-1);
    fireEvent.keyDown(mainRow!, { key: 'ArrowUp' });
    expect(srcRow).toHaveFocus();
  });

  it('Home / End で先頭・末尾の行へ focus が移る', () => {
    renderPanel();
    const items = screen.getAllByRole('treeitem');
    items[1]!.focus();
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1]!, { key: 'Home' });
    expect(items[0]).toHaveFocus();
  });

  it('ArrowRight: 展開済み dir では最初の子へ focus、ArrowLeft: 展開済み dir では折りたたみ', () => {
    renderPanel();
    const [srcRow, mainRow] = screen.getAllByRole('treeitem');
    srcRow!.focus();
    fireEvent.keyDown(srcRow!, { key: 'ArrowRight' });
    expect(mainRow).toHaveFocus();

    srcRow!.focus();
    fireEvent.keyDown(srcRow!, { key: 'ArrowLeft' });
    expect(toggleDir).toHaveBeenCalledWith(ROOT, 'src');
  });

  it('ArrowLeft: ファイル行 (子) では親 dir へ focus が移る', () => {
    renderPanel();
    const [srcRow, mainRow] = screen.getAllByRole('treeitem');
    mainRow!.focus();
    fireEvent.keyDown(mainRow!, { key: 'ArrowLeft' });
    expect(srcRow).toHaveFocus();
  });
});
