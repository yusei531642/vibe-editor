/**
 * ContextMenu outside-click test (Issue #616 / #593).
 *
 * 旧実装は document の `mousedown` で外クリックを検知していた。Canvas Pane で
 * `e.stopPropagation()` を抜いていた combination で「ContextMenu を開いた当の右クリック
 * の mousedown 自身」が外クリックとして誤検出され、メニューが即閉じる race を起こしていた。
 *
 * 修正後は `click` (mouseup 完了後の合成イベント) を listen するようにしたので、
 * 「メニューを開いた右クリック自体」では closure が起きず、外側を通常クリックしたら
 * 閉じる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';

const ITEMS: ContextMenuItem[] = [
  { label: 'Add Claude here', action: vi.fn() },
  { label: 'Delete card', action: vi.fn() }
];

function renderMenu(onClose = vi.fn()) {
  const result = render(
    <ContextMenu x={50} y={60} items={ITEMS} onClose={onClose} />
  );
  return { ...result, onClose };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ContextMenu outside-click handling (Issue #616 / #593)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('right-click 直後に bubble する mousedown では close しない (Issue #616 race fix)', () => {
    const { onClose } = renderMenu();
    // 旧実装は mousedown listener で close していたため、ここで close されてしまっていた。
    // 新実装は click listener なので、mousedown だけでは何も起きない。
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('document に対する click (= mousedown + mouseup) で外クリック扱いされ close する', () => {
    const { onClose } = renderMenu();
    // body 直下の何もない領域を click → outside-click として close
    fireEvent.click(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('menu 内部の menuitem を click しても外クリック扱いはしない (action 実行 + onClose)', () => {
    const action = vi.fn();
    const items: ContextMenuItem[] = [
      { label: 'Add Claude here', action }
    ];
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    const button = screen.getByRole('menuitem', { name: 'Add Claude here' });
    fireEvent.click(button);
    expect(action).toHaveBeenCalledTimes(1);
    // onClose は item.onClick handler 内で 1 回呼ばれるが、その後 document の click bubble
    // で再度発火することは contains() ガードのおかげで起きない (= onClose は 1 回のみ)。
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape キーで close する', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab キーで close する (menu pattern: 次の focusable へ抜ける扱い)', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
