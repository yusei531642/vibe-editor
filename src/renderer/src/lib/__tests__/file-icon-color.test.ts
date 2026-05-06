import { describe, it, expect } from 'vitest';
import { fileIcon, fileIconColor, folderIcon } from '../file-icon-color';

// ---------- fileIcon ----------

describe('fileIcon', () => {
  it('returns correct icon for .ts files', () => {
    const def = fileIcon('app.ts');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#3178c6');
  });

  it('returns correct icon for .tsx files', () => {
    const def = fileIcon('Component.tsx');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#3178c6');
  });

  it('returns correct icon for .js files', () => {
    const def = fileIcon('index.js');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#f7df1e');
  });

  it('handles .d.ts double extension', () => {
    const def = fileIcon('global.d.ts');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#60a5fa');
  });

  it('matches special file names (case-insensitive)', () => {
    const pkg = fileIcon('package.json');
    expect(pkg).toBeDefined();
    expect(pkg!.color).toBe('#dc2626');

    const readme = fileIcon('README.md');
    expect(readme).toBeDefined();
    expect(readme!.color).toBe('#e0e0d6');
  });

  it('returns undefined for unknown extension', () => {
    expect(fileIcon('unknown.xyz')).toBeUndefined();
  });

  it('returns undefined for extensionless unknown file', () => {
    expect(fileIcon('UNKNOWN_FILE')).toBeUndefined();
  });

  it('handles css files', () => {
    const def = fileIcon('styles.css');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#ec4899');
  });

  it('handles markdown files', () => {
    const def = fileIcon('notes.md');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#60a5fa');
  });

  it('handles rust files', () => {
    const def = fileIcon('main.rs');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#ce422b');
  });

  it('handles CLAUDE.md special file', () => {
    const def = fileIcon('CLAUDE.md');
    expect(def).toBeDefined();
    expect(def!.color).toBe('#d97757');
  });
});

// ---------- fileIconColor ----------

describe('fileIconColor', () => {
  it('returns color string for known extension', () => {
    expect(fileIconColor('app.ts')).toBe('#3178c6');
  });

  it('returns undefined for unknown', () => {
    expect(fileIconColor('foo.qqq')).toBeUndefined();
  });
});

// ---------- folderIcon ----------

describe('folderIcon', () => {
  it('returns specific icon for "src" folder', () => {
    const closed = folderIcon('src', false);
    expect(closed.color).toBe('#60a5fa');
    expect(closed.Icon).toBeDefined();

    const open = folderIcon('src', true);
    expect(open.color).toBe('#60a5fa');
    expect(open.Icon).toBeDefined();
  });

  it('returns specific icon for "components" folder', () => {
    const def = folderIcon('components', false);
    expect(def.color).toBe('#f472b6');
  });

  it('returns specific icon for "lib" folder', () => {
    const def = folderIcon('lib', false);
    expect(def.color).toBe('#a78bfa');
  });

  it('returns specific icon for "hooks" folder', () => {
    const def = folderIcon('hooks', false);
    expect(def.color).toBe('#fbbf24');
  });

  it('returns specific icon for "styles" folder', () => {
    const def = folderIcon('styles', false);
    expect(def.color).toBe('#ec4899');
  });

  it('returns specific icon for "tests" and "__tests__"', () => {
    expect(folderIcon('tests', false).color).toBe('#22c55e');
    expect(folderIcon('__tests__', false).color).toBe('#22c55e');
    expect(folderIcon('test', false).color).toBe('#22c55e');
  });

  it('returns specific icon for "docs" folder', () => {
    const def = folderIcon('docs', false);
    expect(def.color).toBe('#60a5fa');
  });

  it('returns specific icon for ".github" folder', () => {
    const def = folderIcon('.github', false);
    expect(def.color).toBe('#f87171');
  });

  it('returns specific icon for "build" and "dist"', () => {
    expect(folderIcon('build', false).color).toBe('#f59e0b');
    expect(folderIcon('dist', false).color).toBe('#f59e0b');
  });

  it('returns specific icon for "node_modules"', () => {
    const def = folderIcon('node_modules', false);
    expect(def.color).toBe('#64748b');
  });

  it('returns specific icon for "src-tauri"', () => {
    const def = folderIcon('src-tauri', false);
    expect(def.color).toBe('#facc15');
  });

  it('returns specific icon for "tasks"', () => {
    const def = folderIcon('tasks', false);
    expect(def.color).toBe('#f97316');
  });

  it('returns specific icon for "skills"', () => {
    const def = folderIcon('skills', false);
    expect(def.color).toBe('#d97757');
  });

  it('is case-insensitive', () => {
    expect(folderIcon('SRC', false).color).toBe('#60a5fa');
    expect(folderIcon('Components', false).color).toBe('#f472b6');
    expect(folderIcon('.GitHub', false).color).toBe('#f87171');
  });

  it('returns default (empty color) for unknown folder names', () => {
    const def = folderIcon('my-custom-folder', false);
    expect(def.color).toBe('');
    expect(def.Icon).toBeDefined();
  });

  it('returns different icons for open vs closed default folders', () => {
    const closed = folderIcon('unknown-folder', false);
    const open = folderIcon('unknown-folder', true);
    // Default folder uses Folder (closed) and FolderOpen (open)
    expect(closed.Icon).not.toBe(open.Icon);
  });

  it('handles "public" and "static" folders', () => {
    expect(folderIcon('public', false).color).toBe('#06b6d4');
    expect(folderIcon('static', false).color).toBe('#06b6d4');
  });

  it('handles "api" and "routes" folders', () => {
    expect(folderIcon('api', false).color).toBe('#10b981');
    expect(folderIcon('routes', false).color).toBe('#10b981');
  });

  it('handles "config" folder', () => {
    expect(folderIcon('config', false).color).toBe('#94a3b8');
  });

  it('handles "scripts" and "bin" folders', () => {
    expect(folderIcon('scripts', false).color).toBe('#22c55e');
    expect(folderIcon('bin', false).color).toBe('#22c55e');
  });

  it('handles "types" folder', () => {
    expect(folderIcon('types', false).color).toBe('#3178c6');
  });

  it('handles "stores" folder', () => {
    expect(folderIcon('stores', false).color).toBe('#facc15');
  });

  it('handles "renderer" folder', () => {
    expect(folderIcon('renderer', false).color).toBe('#60a5fa');
  });
});
