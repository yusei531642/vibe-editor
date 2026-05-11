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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rgbaTokenAlpha(css: string, tokenName: string): number {
  const match = css.match(
    new RegExp(`${escapeRegExp(tokenName)}\\s*:\\s*rgba\\([^)]*,\\s*([0-9.]+)\\s*\\)`)
  );
  expect(match, `${tokenName} should be an rgba token`).not.toBeNull();
  return Number(match?.[1]);
}

function cssDeclarationsForProperty(
  css: string,
  property: 'backdrop-filter' | '-webkit-backdrop-filter'
): Array<{ selector: string; property: string }> {
  const code = stripCssComments(css);
  const declarations: Array<{ selector: string; property: string }> = [];
  const pattern = new RegExp(`${property.replace('-', '\\-')}\\s*:`, 'g');

  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    const openBrace = code.lastIndexOf('{', index);
    const previousCloseBrace = code.lastIndexOf('}', openBrace);
    const selector = code.slice(previousCloseBrace + 1, openBrace).trim();
    declarations.push({ selector, property });
  }

  return declarations;
}

describe('Glass CSS contract', () => {
  it('main.tsx imports glass.css after component CSS and before final image-preview CSS', () => {
    const imports = importedCssPaths(readRendererFile('main.tsx'));

    const glassIndex = imports.indexOf('styles/components/glass.css');
    expect(glassIndex).toBeGreaterThanOrEqual(0);

    // Glass effects must win over component base CSS, but image-preview remains final override.
    for (const componentCss of [
      'styles/components/canvas.css',
      'styles/components/claude-patterns.css',
      'styles/components/shell.css'
    ]) {
      expect(glassIndex).toBeGreaterThan(imports.indexOf(componentCss));
    }
    expect(glassIndex).toBeLessThan(imports.indexOf('styles/components/image-preview.css'));
  });

  it('tokens.css owns --glass-* values, not glass visual effects', () => {
    const tokens = stripCssComments(readRendererFile('styles/tokens.css'));

    for (const tokenName of [
      '--glass-layout-tint',
      '--glass-canvas-layout-tint',
      '--glass-blur',
      '--glass-saturate',
      '--glass-brightness',
      '--glass-border',
      '--glass-highlight'
    ]) {
      expect(tokens).toMatch(new RegExp(`${tokenName}\\s*:`));
    }

    expect(tokens).not.toMatch(/backdrop-filter\s*:/);
    expect(tokens).not.toMatch(/-webkit-backdrop-filter\s*:/);
    expect(tokens).not.toMatch(/\[data-theme=['"]glass['"]\]\s+\.glass-surface/);
  });

  it('keeps the Glass canvas root tint more transparent than the IDE root tint', () => {
    const tokens = stripCssComments(readRendererFile('styles/tokens.css'));

    const layoutAlpha = rgbaTokenAlpha(tokens, '--glass-layout-tint');
    const canvasAlpha = rgbaTokenAlpha(tokens, '--glass-canvas-layout-tint');

    // canvas は IDE より透ける関係を維持。下限はガラス感を強めた現行値 (0.18 系) を
    // 許容するため緩和。OS Acrylic + surface 半透明の二重で壁紙の白成分は抑える前提。
    expect(canvasAlpha).toBeLessThan(layoutAlpha);
    expect(canvasAlpha).toBeGreaterThanOrEqual(0.15);
  });

  it('glass.css owns root transparency, root tint, glass-surface effects, and major surfaces', () => {
    const glass = stripCssComments(readComponentCss('glass.css'));

    expect(glass).toMatch(
      /:root\[data-theme='glass'\][\s\S]*:root\[data-theme='glass'\]\s+body[\s\S]*:root\[data-theme='glass'\]\s+#root\s*\{[\s\S]*background:\s*transparent\s*!important/
    );
    const glassFilterSelectors = [
      ...cssDeclarationsForProperty(glass, 'backdrop-filter'),
      ...cssDeclarationsForProperty(glass, '-webkit-backdrop-filter')
    ].map((d) => d.selector);
    expect(glassFilterSelectors).not.toContain(":root[data-theme='glass'] .layout");
    expect(glassFilterSelectors).not.toContain(":root[data-theme='glass'] .canvas-layout");
    expect(glass).toMatch(
      /:root\[data-theme='glass'\]\s+\.layout\s*\{[\s\S]*background:\s*var\(--glass-layout-tint,\s*rgba\(10,\s*10,\s*26,\s*0\.55\)\)/
    );
    expect(glass).toMatch(
      /:root\[data-theme='glass'\]\s+\.canvas-layout\s*\{[\s\S]*background:\s*var\(--glass-canvas-layout-tint,\s*rgba\(10,\s*10,\s*26,\s*0\.40\)\)/
    );
    expect(glass).toMatch(
      /:root\[data-theme='glass'\]\s+\.glass-surface[\s\S]*backdrop-filter:\s*blur\(var\(--glass-blur\)\)/
    );

    for (const selector of [
      '.glass-surface',
      '.sidebar',
      '.filetree',
      '.rail',
      '.topbar',
      '.statusbar',
      '.main',
      '.toolbar',
      '.tabbar',
      '.modal',
      '.cmdp',
      '.app-menu__dropdown',
      '.user-menu__dropdown',
      '.content-area',
      '.pane',
      '.terminal-pane',
      '.claude-code-panel',
      '.canvas-agent-card',
      '.canvas-toolbar'
    ]) {
      expect(glass).toContain(`:root[data-theme='glass'] ${selector}`);
    }
  });

  it('index.css does not keep the legacy Issue #16 Glass surface whitelist', () => {
    const indexCss = stripCssComments(readRendererFile('index.css'));

    // A few narrow Glass exceptions may remain in index.css (for example xterm/filetree).
    // The old regression-prone whitelist for broad surfaces must stay out of index.css.
    for (const selector of [
      '.toolbar',
      '.sidebar',
      '.topbar',
      '.main',
      '.content-area',
      '.pane',
      '.terminal-pane',
      '.claude-code-panel',
      '.canvas-agent-card',
      '.canvas-toolbar',
      '.modal',
      '.cmdp',
      '.app-menu__dropdown',
      '.user-menu__dropdown'
    ]) {
      expect(indexCss).not.toMatch(
        new RegExp(`\\[data-theme=["']glass["']\\]\\s+\\${selector.replace('.', '.')}`)
      );
    }
  });

  it('remaining backdrop-filter declarations are limited to the documented allowlist', () => {
    const cssFiles = cssFilesUnder(rendererSrcDir);
    const unexpectedDeclarations = cssFiles.flatMap((file) => {
      const rel = slashPath(relative(rendererSrcDir, file));
      const css = readFileSync(file, 'utf8');
      const declarations = [
        ...cssDeclarationsForProperty(css, 'backdrop-filter'),
        ...cssDeclarationsForProperty(css, '-webkit-backdrop-filter')
      ];

      return declarations
        .filter(({ selector }) => {
          if (rel === 'styles/components/glass.css') return false;
          if (rel === 'styles/components/menu.css') return false;
          if (rel === 'styles/components/modal.css') return false;
          if (rel === 'styles/components/palette.css') return false;
          if (rel === 'styles/components/canvas.css') return !selector.includes('.tc__hud');
          if (rel === 'index.css') {
            // index.css may keep local UI blur, but not broad Glass surface blur.
            return /(\.toolbar|\.sidebar|\.topbar|\.main|\.claude-code-panel|\.canvas-agent-card|\.canvas-toolbar)/.test(
              selector
            );
          }
          return true;
        })
        .map(({ selector, property }) => `${rel} :: ${selector} :: ${property}`);
    });

    expect(unexpectedDeclarations).toEqual([]);
  });
});
