import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TabBar, type TabItem } from '../TabBar';

vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string) => key
}));

const TABS: TabItem[] = [
  { id: 'terminal', title: 'Terminal' },
  { id: 'editor', title: 'Editor' },
  { id: 'preview', title: 'Preview' }
];

function renderTabBar(activeId = 'terminal') {
  const onSelect = vi.fn();
  const result = render(<TabBar tabs={TABS} activeId={activeId} onSelect={onSelect} />);
  return { ...result, onSelect };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TabBar keyboard navigation', () => {
  it('ArrowRight / ArrowLeft で隣の tab を選択して focus を移す (Issue #847)', () => {
    const { onSelect } = renderTabBar('terminal');
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('editor');
    expect(tabs[1]).toHaveFocus();

    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('preview');
    expect(tabs[2]).toHaveFocus();
  });

  it('Home / End で先頭と末尾の tab を選択して focus を移す', () => {
    const { onSelect } = renderTabBar('editor');
    const tabs = screen.getAllByRole('tab');

    tabs[1]?.focus();
    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('preview');
    expect(tabs[2]).toHaveFocus();

    fireEvent.keyDown(tabs[1]!, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('terminal');
    expect(tabs[0]).toHaveFocus();
  });
});
