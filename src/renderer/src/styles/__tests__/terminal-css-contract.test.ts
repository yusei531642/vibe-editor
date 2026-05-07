/// <reference types="node" />

/**
 * Terminal CSS contract test (Issue #496).
 *
 * IDE モード (`.terminal-pane .terminal-view ...`) のターミナル scrollbar が
 * hover で消えて掴めない症状の再発を防ぐためのレグレッションガード。
 * xterm v6 SmoothScrollableElement は autohide が JS 側で切替わるため、CSS で
 * `.scrollbar.vertical` を常時表示・操作可能に固定する必要がある。
 *
 * Canvas 側 (`.react-flow__node` 配下) は `canvas.css` に同等ルールが存在し、
 * そちらは触らないことも合わせて明示する。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);
const rendererSrcDir = dirname(stylesDir);
const componentsDir = join(stylesDir, 'components');

function readIndexCss(): string {
  return readFileSync(join(rendererSrcDir, 'index.css'), 'utf8');
}

function readComponentCss(fileName: string): string {
  return readFileSync(join(componentsDir, fileName), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Terminal CSS contract (Issue #496)', () => {
  it('keeps the IDE-mode xterm vertical scrollbar always visible and interactive', () => {
    const css = stripCssComments(readIndexCss());

    expect(css).toMatch(
      /\.terminal-pane\s+\.terminal-view\s+\.xterm-scrollable-element\s*>\s*\.scrollbar\.vertical\s*\{[\s\S]*opacity:\s*1\s*!important[\s\S]*visibility:\s*visible\s*!important[\s\S]*pointer-events:\s*auto\s*!important[\s\S]*transition:\s*none\s*!important[\s\S]*\}/
    );
  });

  it('keeps the Canvas-mode xterm vertical scrollbar always visible (Issue #272 v4 unchanged)', () => {
    const css = stripCssComments(readComponentCss('canvas.css'));

    expect(css).toMatch(
      /\.react-flow__node\s+\.terminal-view\s+\.xterm-scrollable-element\s*>\s*\.scrollbar\.vertical\s*\{[\s\S]*opacity:\s*1\s*!important[\s\S]*visibility:\s*visible\s*!important[\s\S]*pointer-events:\s*auto\s*!important[\s\S]*transition:\s*none\s*!important[\s\S]*\}/
    );
  });
});
