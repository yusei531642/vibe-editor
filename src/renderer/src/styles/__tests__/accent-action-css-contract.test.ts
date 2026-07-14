import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'components');
const readCss = (name: string): string =>
  readFileSync(join(componentsDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} rule must exist`).not.toBeNull();
  return match![1];
}

describe('Issue #1169 accent action CSS contract', () => {
  it('Agent Wizard primary action uses the theme accent pair', () => {
    const declarations = rule(readCss('agent-wizard.css'), '.agent-wizard__primary');
    expect(declarations).toMatch(/background:\s*var\(--accent,\s*#d97757\)\s*;/);
    expect(declarations).toMatch(/color:\s*var\(--accent-foreground,\s*#fff\)\s*;/);
    expect(declarations).not.toMatch(/color:\s*#fff\s*;/);
  });

  it('API chat send action does not use arbitrary agent color as its background', () => {
    const declarations = rule(readCss('canvas.css'), '.api-chat__send');
    expect(declarations).toMatch(/background:\s*var\(--accent\)\s*;/);
    expect(declarations).toMatch(/color:\s*var\(--accent-foreground,\s*#fff\)\s*;/);
    expect(declarations).not.toMatch(/background:\s*var\(--chat-accent\)/);
    expect(declarations).not.toMatch(/color:\s*#fff\s*;/);
  });
});
