/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);
const rendererSrcDir = dirname(stylesDir);
const componentsDir = join(stylesDir, 'components');

function readRendererFile(pathFromRendererSrc: string): string {
  return readFileSync(join(rendererSrcDir, pathFromRendererSrc), 'utf8');
}

function readComponentCss(fileName: string): string {
  return readFileSync(join(componentsDir, fileName), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function importedCssPaths(mainTsx: string): string[] {
  return Array.from(mainTsx.matchAll(/^import\s+['"]\.\/([^'"]+\.css)['"];?$/gm), (match) => match[1]);
}

function cssFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return cssFilesUnder(fullPath);
    return entry.isFile() && entry.name.endsWith('.css') ? [fullPath] : [];
  });
}

function slashPath(path: string): string {
  return path.replace(/\\/g, '/');
}

describe('Drag-region CSS contract', () => {
  it('main.tsx imports drag-region.css after glass.css and before final tweaks', () => {
    const imports = importedCssPaths(readRendererFile('main.tsx'));

    const dragIndex = imports.indexOf('styles/components/drag-region.css');
    expect(dragIndex).toBeGreaterThanOrEqual(0);
    expect(dragIndex).toBeGreaterThan(imports.indexOf('styles/components/glass.css'));
    expect(dragIndex).toBeLessThan(imports.indexOf('styles/components/tweaks.css'));
    expect(dragIndex).toBeLessThan(imports.indexOf('styles/components/image-preview.css'));
  });

  it('drag-region.css defines drag and no-drag rules with no-drag after drag', () => {
    const dragCss = stripCssComments(readComponentCss('drag-region.css'));
    const dragRuleIndex = dragCss.indexOf('app-region: drag');
    const webkitDragRuleIndex = dragCss.indexOf('-webkit-app-region: drag');
    const noDragRuleIndex = dragCss.indexOf('app-region: no-drag');
    const webkitNoDragRuleIndex = dragCss.indexOf('-webkit-app-region: no-drag');

    expect(dragRuleIndex).toBeGreaterThanOrEqual(0);
    expect(webkitDragRuleIndex).toBeGreaterThanOrEqual(0);
    expect(noDragRuleIndex).toBeGreaterThanOrEqual(0);
    expect(webkitNoDragRuleIndex).toBeGreaterThanOrEqual(0);
    expect(noDragRuleIndex).toBeGreaterThan(dragRuleIndex);
    expect(webkitNoDragRuleIndex).toBeGreaterThan(webkitDragRuleIndex);
  });

  it('drag-region.css keeps interactive controls in the no-drag allowlist', () => {
    const dragCss = stripCssComments(readComponentCss('drag-region.css'));

    for (const selector of [
      'button',
      'input',
      'textarea',
      'select',
      'a',
      "[role='button']",
      '.menubar',
      '.app-menu',
      '.app-menu__trigger',
      '.app-menu__dropdown',
      '.user-menu__dropdown',
      '.context-menu',
      '.topbar__project',
      '.topbar__search',
      '.topbar__icons',
      '.window-controls',
      '.window-controls__btn',
      '.canvas-btn',
      '.canvas-btn-split',
      '.canvas-btn-split__main',
      '.canvas-btn-split__caret',
      '.canvas-popover__wrap',
      '.canvas-popover',
      '.resize-handle'
    ]) {
      expect(dragCss).toContain(selector);
    }
  });

  it('production CSS app-region declarations are centralized in drag-region.css', () => {
    const offenders = cssFilesUnder(rendererSrcDir).flatMap((file) => {
      const rel = slashPath(relative(rendererSrcDir, file));
      if (rel === 'styles/components/drag-region.css') return [];

      const css = stripCssComments(readFileSync(file, 'utf8'));
      return /(?:^|[;{\s])-?webkit-app-region\s*:|(?:^|[;{\s])app-region\s*:/m.test(css)
        ? [rel]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it('Topbar root remains an explicit Tauri drag region', () => {
    const topbar = readRendererFile('components/shell/Topbar.tsx');
    const rootTag = topbar.match(/<div\s+[^>]*className="topbar"[^>]*>/)?.[0] ?? '';

    expect(rootTag).toContain('data-tauri-drag-region');
  });

});
