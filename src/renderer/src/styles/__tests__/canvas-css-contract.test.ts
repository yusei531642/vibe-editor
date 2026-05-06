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
});
