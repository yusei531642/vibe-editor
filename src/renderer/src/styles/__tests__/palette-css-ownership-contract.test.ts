/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(testDir, '..', '..');

function readRendererFile(path: string): string {
  return readFileSync(join(rendererDir, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Command palette CSS ownership (Issue #1172)', () => {
  it('keeps the obsolete command palette backdrop definition out of index.css', () => {
    const indexCss = readRendererFile('index.css');

    expect(indexCss).not.toContain('.cmdp-backdrop');
    expect(indexCss).not.toMatch(/z-index:\s*2000/);
  });

  it('owns the Canvas-safe palette layer in palette.css', () => {
    const palette = readRendererFile('styles/components/palette.css');

    expect(palette).toMatch(/\.cmdp-backdrop\s*\{[^}]*z-index:\s*var\(--z-palette\)/);
  });

  it('uses the shared backdrop token instead of duplicating 499 in AppShell', () => {
    const appShell = readRendererFile('components/AppShell.tsx');

    expect(appShell).toContain("zIndex: 'var(--z-cmd-backdrop)'");
    expect(appShell).not.toMatch(/zIndex:\s*499/);
  });
});
