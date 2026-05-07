/// <reference types="node" />

/**
 * Issue #503 Fix 2: `.canvas-agent-card::before` (左端 accent bar) と
 * `.canvas-agent-card__term` (xterm の wrapper) が物理的に重ならないことを保証する
 * 静的 CSS 契約テスト。
 *
 * accent bar は `position: absolute; left: 0; width: <px>` で描画され、`__term` は
 * 同じ stacking context 内に置かれる。`__term` 側に十分な `padding-left` が無いと
 * xterm の最初のカラムが accent bar と重なり、Canvas モードで起動直後の数フレームで
 * 「最初の glyph が縦帯と交差して見える」描画崩れになる (Issue #503 主因 #2)。
 *
 * z-index で stacking context を作る対策は #253 で確認済みの zoom 滲み回帰リスクが
 * あるため採らない (canvas.css の関連コメント参照)。
 *
 * 本テストは `canvas.css` を fs で読み regex で width / padding-left を px 数値として
 * 抽出し、`padding-left ≥ width` を assert する。jsdom + getComputedStyle は ::before
 * の width を正確に拾えないため、テキストベースで契約を固定する。
 *
 * 参考: ./terminal-css-contract.test.ts (同じ「CSS をテキストで読んで regex で検証」
 *       スタイル)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesDir = dirname(testDir);
const componentsDir = join(stylesDir, 'components');

function readComponentCss(fileName: string): string {
  return readFileSync(join(componentsDir, fileName), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 指定セレクタの宣言ブロック (`{ ... }`) を 1 件だけ抜き出す。
 * 同セレクタが複数回宣言されているケースは想定していない (canvas.css は単一)。
 */
function extractDeclarationBlock(css: string, selector: string): string {
  // セレクタの直前に空白か行頭、直後に `\s*{` が来る箇所をマッチ。
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m) {
    throw new Error(`selector not found: ${selector}`);
  }
  return m[1];
}

/**
 * 宣言ブロックから 1 件の px 数値プロパティ値を返す。`!important` 等は無視。
 * 値が px で書かれていない (var(...) 等) 場合は null を返す — 数値比較できないため
 * 呼び出し側で明示的に失敗させる。
 */
function extractPxValue(block: string, prop: string): number | null {
  const escaped = prop.replace(/[-]/g, '\\-');
  const re = new RegExp(`(?:^|;|\\s)${escaped}\\s*:\\s*([^;]+?)\\s*(?:;|$)`, 'i');
  const m = block.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  const pxMatch = raw.match(/^(\d+(?:\.\d+)?)px$/);
  if (!pxMatch) return null;
  return parseFloat(pxMatch[1]);
}

describe('Canvas accent bar contract (Issue #503 Fix 2)', () => {
  const css = stripCssComments(readComponentCss('canvas.css'));

  it('.canvas-agent-card::before (accent bar) は px 単位の固定 width を持つ', () => {
    const beforeBlock = extractDeclarationBlock(css, '.canvas-agent-card::before');
    const width = extractPxValue(beforeBlock, 'width');
    expect(width).not.toBeNull();
    expect(width).toBeGreaterThan(0);
  });

  it('.canvas-agent-card__term は accent bar の width 以上の padding-left を持つ', () => {
    const beforeBlock = extractDeclarationBlock(css, '.canvas-agent-card::before');
    const termBlock = extractDeclarationBlock(css, '.canvas-agent-card__term');

    const accentWidth = extractPxValue(beforeBlock, 'width');
    const termPaddingLeft = extractPxValue(termBlock, 'padding-left');

    // accent bar / wrapper の値が両方 px で記述されていることを保証する。
    // var(...) 等で書かれた途端に静的解析できなくなるので、明示的にエラーにする。
    expect(accentWidth).not.toBeNull();
    expect(termPaddingLeft).not.toBeNull();

    // 主張: padding-left は accent bar の width 以上。等号も許可するが、サブピクセル
    // 揺らぎを考慮して 1px 以上の余裕を持たせるのが望ましい (canvas.css 現状: 4px ≥ 3px)。
    expect(termPaddingLeft as number).toBeGreaterThanOrEqual(accentWidth as number);
  });
});
