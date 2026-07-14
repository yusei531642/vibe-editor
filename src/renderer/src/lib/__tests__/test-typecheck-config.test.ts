import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WebTsConfig {
  include?: string[];
  exclude?: string[];
}

describe('test typecheck configuration', () => {
  it('includes renderer tests in the strict web project', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.web.json'), 'utf8')
    ) as WebTsConfig;

    expect(config.include).toContain('src/renderer/**/*.ts');
    expect(config.include).toContain('src/renderer/**/*.tsx');
    expect(config.exclude ?? []).not.toContain('src/renderer/src/**/__tests__/**');
  });
});
