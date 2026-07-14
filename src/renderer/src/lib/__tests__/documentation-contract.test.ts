import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const documentPaths = [
  'CLAUDE.md',
  '.claude/skills/vibeeditor/SKILL.md',
  'README.md',
  'README-ja.md'
] as const;

const readDocument = (path: (typeof documentPaths)[number]) =>
  readFileSync(resolve(root, path), 'utf8');

describe('project documentation contract', () => {
  it('does not reintroduce obsolete stack or command descriptions', () => {
    const obsoletePatterns = [
      /React 18/,
      /TypeScript 5\.6/,
      /Vite 5/,
      /v1\.4\.x/,
      /tsc --noEmit/
    ];

    for (const path of documentPaths) {
      const content = readDocument(path);
      for (const pattern of obsoletePatterns) {
        expect(content, `${path} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps the required project guides aligned with manifest majors', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8')
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const claude = readDocument('CLAUDE.md');
    const vibeeditor = readDocument('.claude/skills/vibeeditor/SKILL.md');

    expect(packageJson.dependencies.react).toMatch(/^\^19\./);
    expect(packageJson.devDependencies.typescript).toMatch(/^\^6\./);
    expect(packageJson.devDependencies.vite).toMatch(/^\^8\./);
    expect(packageJson.scripts.typecheck).toBe('tsc -b --force');

    for (const content of [claude, vibeeditor]) {
      expect(content).toContain('Tauri 2');
      expect(content).toContain('Vite 8');
      expect(content).toContain('React 19');
      expect(content).toContain('TypeScript 6');
    }
    expect(vibeeditor).toContain('npm run typecheck    # tsc -b --force');
  });

  it('references only the replacement project skills', () => {
    const vibeeditor = readDocument('.claude/skills/vibeeditor/SKILL.md');

    expect(vibeeditor).not.toContain('`issue-fix` skill');
    expect(vibeeditor).not.toContain('`finalfix` skill');
    for (const skill of ['pullrequest', 'issue-plan', 'pty-portable-debugging', 'claude-design', 'vibe-team']) {
      expect(existsSync(resolve(root, `.claude/skills/${skill}/SKILL.md`)), skill).toBe(true);
    }
  });
});
