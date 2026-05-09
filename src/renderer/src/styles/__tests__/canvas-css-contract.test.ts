/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);
const componentsDir = join(stylesDir, 'components');

function readStyleFile(pathFromStylesDir: string): string {
  return readFileSync(join(stylesDir, pathFromStylesDir), 'utf8');
}

function readComponentCss(fileName: string): string {
  return readFileSync(join(componentsDir, fileName), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Canvas CSS contract', () => {
  it('keeps the canvas sidebar width aligned with the redesign shell sidebar token', () => {
    const tokens = stripCssComments(readStyleFile('tokens.css'));
    const canvas = stripCssComments(readComponentCss('canvas.css'));

    expect(tokens).toMatch(/--shell-sidebar-w\s*:\s*272px\s*;/);
    expect(canvas).toMatch(
      /\.canvas-layout__body\s*>\s*\.sidebar\s*\{[\s\S]*flex:\s*0\s+0\s+var\(--shell-sidebar-w\)\s*;[\s\S]*width:\s*var\(--shell-sidebar-w\)\s*;[\s\S]*min-width:\s*var\(--shell-sidebar-w\)\s*;[\s\S]*max-width:\s*var\(--shell-sidebar-w\)\s*;/
    );
  });

  it('keeps canvas list rows wired to the same agent and organization accent variables as stage cards', () => {
    const canvas = stripCssComments(readComponentCss('canvas.css'));

    expect(canvas).toMatch(
      /\.tc-list-row\s*\{[\s\S]*box-shadow:\s*inset\s+3px\s+0\s+0\s+var\(--organization-accent,\s*var\(--agent-accent,\s*var\(--accent\)\)\)\s*;/
    );
    expect(canvas).toMatch(
      /\.tc-list-row__avatar\s*\{[\s\S]*var\(--agent-accent,\s*var\(--role-color,\s*var\(--accent\)\)\)/
    );
    expect(canvas).toMatch(
      /\.tc-list-row__role\s*\{[\s\S]*color:\s*var\(--agent-accent,\s*var\(--role-color,\s*var\(--text-mute\)\)\)\s*;/
    );
    expect(canvas).toMatch(
      /\.tc-list-row__status-dot\s*\{[\s\S]*background:\s*var\(--agent-accent,\s*var\(--role-color,\s*var\(--success\)\)\)\s*;/
    );
  });

  it('Issue #610: --canvas-grid is defined for every theme so the Background grid follows the theme', () => {
    const tokens = stripCssComments(readStyleFile('tokens.css'));

    // 全 6 テーマ + :root fallback がカバーされていることを保証する。新規テーマを足したら
    // 同じく tokens.css に --canvas-grid を 1 行足すことで Canvas.tsx は触らずに対応できる。
    for (const theme of ['claude-dark', 'claude-light', 'dark', 'light', 'midnight', 'glass']) {
      const blockRe = new RegExp(
        String.raw`\[data-theme='${theme}'\][^{]*\{[\s\S]*?--canvas-grid\s*:[^;]+;[\s\S]*?\}`
      );
      expect(tokens, `theme '${theme}' must define --canvas-grid`).toMatch(blockRe);
    }
  });

  it('Issue #610: canvas.css targets the React Flow background pattern via CSS so SVG attributes do not strand var()', () => {
    const canvas = stripCssComments(readComponentCss('canvas.css'));

    // dots variant (`<circle>`) と lines/cross variant (`<path>`) の両方を
    // var(--canvas-grid) で上書きすることで、xyflow がどの variant を選んでも
    // テーマ追従する。フォールバック値も hex で残しておく (variable 未定義時の保険)。
    expect(canvas).toMatch(
      /\.react-flow__background-pattern\s+circle\s*\{[\s\S]*fill:\s*var\(--canvas-grid[^)]*\)\s*;/
    );
    expect(canvas).toMatch(
      /\.react-flow__background-pattern\s+path\s*\{[\s\S]*stroke:\s*var\(--canvas-grid[^)]*\)\s*;/
    );
  });
});
