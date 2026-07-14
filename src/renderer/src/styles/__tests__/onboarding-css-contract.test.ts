/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);

function readStyleFile(pathFromStylesDir: string): string {
  return readFileSync(join(stylesDir, pathFromStylesDir), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readZIndexToken(tokens: string, name: string): number {
  const match = tokens.match(new RegExp(String.raw`${name}\s*:\s*(\d+)\s*;`));
  expect(match, `tokens.css must define ${name} as a plain number`).not.toBeNull();
  return Number(match![1]);
}

describe('Onboarding CSS contract (Issue #1170)', () => {
  it('stacks onboarding above Canvas and other active overlays', () => {
    const tokens = stripCssComments(readStyleFile('tokens.css'));

    const zOnboarding = readZIndexToken(tokens, '--z-onboarding');
    const zPalette = readZIndexToken(tokens, '--z-palette');
    const zContextMenu = readZIndexToken(tokens, '--z-context-menu');
    const zCanvasRoot = readZIndexToken(tokens, '--z-canvas-root');

    expect(zOnboarding).toBeGreaterThan(zPalette);
    expect(zPalette).toBeGreaterThan(zContextMenu);
    expect(zContextMenu).toBeGreaterThan(zCanvasRoot);
  });

  it('uses the shared onboarding layer token instead of a numeric z-index', () => {
    const onboarding = stripCssComments(readStyleFile('components/onboarding.css'));
    const rule = onboarding.match(/\.onboarding\s*\{([^}]*)\}/)?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/z-index:\s*var\(--z-onboarding\)\s*;/);
    expect(rule).not.toMatch(/z-index:\s*\d+/);
  });
});
