// electron-builder 用アイコン生成スクリプト
// 入力: build/icon-master.png (Playwright で SVG を rasterize 済み、1100x1100)
// 出力:
//   build/icon.png      1024x1024 PNG (Linux / electron-builder main)
//   build/icon.ico      Windows (16/24/32/48/64/128/256 同梱)
//   build/icon-NN.png   個別サイズ (デバッグ用)

import sharp from 'sharp';
import toIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

async function main() {
  const masterPath = join(root, 'icon-master.png');
  console.log('[icons] reading master:', masterPath);

  // Playwright viewport (1100) から 1024x1024 を抽出（左上基準）
  const master1024 = await sharp(masterPath)
    .extract({ left: 0, top: 0, width: 1024, height: 1024 })
    .png()
    .toBuffer();
  writeFileSync(join(root, 'icon.png'), master1024);
  console.log('[icons] wrote icon.png (1024x1024)');

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngPaths = [];
  for (const size of sizes) {
    const p = join(root, `icon-${size}.png`);
    await sharp(master1024).resize(size, size).png().toFile(p);
    pngPaths.push(p);
    console.log(`[icons] wrote icon-${size}.png`);
  }

  // ico ファイル生成（16/24/32/48/64/128/256 を統合）
  const ico = await toIco(pngPaths);
  writeFileSync(join(root, 'icon.ico'), ico);
  console.log('[icons] wrote icon.ico (multi-size Windows icon)');

  console.log('[icons] done');
}

main().catch((err) => {
  console.error('[icons] failed:', err);
  process.exit(1);
});
