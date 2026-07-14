/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);

function readTokens(): string {
  return readFileSync(join(stylesDir, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

function densityRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`:root\\[data-density\\]\\s+${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `density rule for ${selector}`).not.toBeNull();
  return match![1];
}

describe('Density-aware sidebar list rows (Issue #1171)', () => {
  it.each(['.gitfile', '.session', '.team-history-item__main'])(
    'wires row height, padding, and gap tokens into %s',
    (selector) => {
      const rule = densityRule(readTokens(), selector);

      expect(rule).toContain('var(--row-h)');
      expect(rule).toContain('var(--pad)');
      expect(rule).toContain('var(--gap)');
    },
  );
});
