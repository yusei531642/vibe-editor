/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);
const componentsDir = join(stylesDir, 'components');

function readStyleFile(pathFromStylesDir: string): string {
  return readFileSync(join(stylesDir, pathFromStylesDir), 'utf8');
}

function readComponentCss(fileName: string): string {
  return readFileSync(join(componentsDir, fileName), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readZIndexToken(tokens: string, name: string): number {
  const match = tokens.match(new RegExp(String.raw`${name}\s*:\s*(\d+)\s*;`));
  expect(match, `tokens.css must define ${name} as a plain number`).not.toBeNull();
  return Number(match![1]);
}

/*
 * jsdom は CSS を適用しないため computed style では検出できない。Issue #884 では
 * redesign 時に .toast-container の position 宣言が落ち、toast が viewport 外へ
 * 押し出されて約 2 ヶ月間まったく表示されなかった。同型の「宣言落ち」退行を
 * テキストレベルでガードする。
 */
describe('Toast CSS contract (Issue #884)', () => {
  it('keeps .toast-container fixed-positioned so top/left/transform take effect', () => {
    const toast = stripCssComments(readComponentCss('toast.css'));

    expect(toast).toMatch(/\.toast-container\s*\{[^}]*position:\s*fixed\s*;/);
  });

  it('stacks toasts above the Canvas root but below active UI (context menu / palette)', () => {
    const tokens = stripCssComments(readStyleFile('tokens.css'));

    const zToast = readZIndexToken(tokens, '--z-toast');
    const zToastTop = readZIndexToken(tokens, '--z-toast-top');
    const zCanvasRoot = readZIndexToken(tokens, '--z-canvas-root');
    const zContextMenu = readZIndexToken(tokens, '--z-context-menu');
    const zPalette = readZIndexToken(tokens, '--z-palette');

    // Canvas モード (.canvas-layout = --z-canvas-root) でも toast が視認できること
    expect(zToast).toBeGreaterThan(zCanvasRoot);
    expect(zToastTop).toBeGreaterThan(zCanvasRoot);
    // 受動通知が能動 UI を覆わないこと
    expect(zToastTop).toBeLessThan(zContextMenu);
    expect(zToastTop).toBeLessThan(zPalette);
  });

  it('restores .toast flex layout and pointer-events lost in the redesign migration', () => {
    const toast = stripCssComments(readComponentCss('toast.css'));

    // .toast__body の flex: 1 と media query の flex-wrap は .toast の flex を前提とする
    expect(toast).toMatch(/\.toast\s*\{[^}]*display:\s*flex\s*;/);
    // container は pointer-events: none (クリック透過) なので本体で auto に戻す
    expect(toast).toMatch(/\.toast\s*\{[^}]*pointer-events:\s*auto\s*;/);
  });
});
