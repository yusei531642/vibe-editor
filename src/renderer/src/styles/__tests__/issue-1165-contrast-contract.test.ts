import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'components');
const readCss = (fileName: string): string =>
  readFileSync(join(componentsDir, fileName), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('Issue #1165 contrast CSS contract', () => {
  it('設定primary buttonはaccent foreground tokenを使う', () => {
    expect(readCss('modal.css')).toMatch(
      /\.settings-button--primary\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-foreground\);[^}]*\}/
    );
  });

  it('Canvas role dotは背景色と対になるforeground変数を使う', () => {
    const canvas = readCss('canvas.css');
    expect(canvas).toMatch(
      /\.canvas-role-dot\s*\{[^}]*background:\s*var\(--dot-color,\s*var\(--accent\)\);[^}]*color:\s*var\(--dot-foreground,\s*var\(--accent-foreground\)\);[^}]*\}/
    );
    expect(canvas).not.toContain('.canvas-agent-card__avatar');
  });
});
