// electron-builder 用アイコン生成スクリプト
// 入力: build/icon.svg (Source of truth)
// 出力:
//   build/icon.png      1024x1024 PNG (macOS / Linux / electron-builder main)
//   build/icon.ico      Windows マルチサイズ (16/24/32/48/64/128/256)
//   build/icon-NN.png   個別サイズ (デバッグ用、.gitignore対象)
//
// sharp + librsvg が SVG + Georgia フォントを解決できるので、
// Playwright 等の Chromium ラスタライザは不要。

import sharp from 'sharp';
import toIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

async function main() {
  const svgPath = join(root, 'icon.svg');
  console.log('[icons] reading source:', svgPath);

  // 1024x1024 マスター PNG
  const master = await sharp(svgPath).resize(1024, 1024).png().toBuffer();
  writeFileSync(join(root, 'icon.png'), master);
  writeFileSync(join(root, 'icon-master.png'), master);
  console.log('[icons] wrote icon.png (1024x1024)');

  // 各サイズの PNG を sharp で生成
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngPaths = [];
  for (const size of sizes) {
    const p = join(root, `icon-${size}.png`);
    await sharp(svgPath).resize(size, size).png().toFile(p);
    pngPaths.push(p);
    console.log(`[icons] wrote icon-${size}.png`);
  }

  // マルチサイズ ICO 生成
  const ico = await toIco(pngPaths);
  writeFileSync(join(root, 'icon.ico'), ico);
  console.log('[icons] wrote icon.ico');

  console.log('[icons] done');
}

main().catch((err) => {
  console.error('[icons] failed:', err);
  process.exit(1);
});
