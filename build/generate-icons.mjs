// electron-builder 用アイコン生成スクリプト
// 入力: build/icon.svg (Source of truth)
// 出力:
//   build/icon.png              1024x1024 PNG (macOS / Linux / electron-builder main)
//   build/icon.ico              Windows マルチサイズ (16/24/32/48/64/128/256)
//   build/icon-NN.png           個別サイズ (デバッグ用、.gitignore対象)
//   build/installerSidebar.bmp  NSIS ウェルカム/完了画面のサイドバー (164×314)
//   build/installerHeader.bmp   NSIS ヘッダバー (150×57) ※現状 oneClick では使われない
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

  // NSIS サイドバー (164x314) とヘッダ (150x57)。
  // 背景色はブランドのウォームダーク、中央にアイコン、下にプロダクト名を透過合成。
  await generateNsisSidebar();
  await generateNsisHeader();

  console.log('[icons] done');
}

/** 164×314 のサイドバー BMP を生成 */
async function generateNsisSidebar() {
  const width = 164;
  const height = 314;
  const background = { r: 26, g: 26, b: 46, alpha: 1 };

  // 中央寄りに 96x96 のアイコンを配置
  const iconBuf = await sharp(join(root, 'icon.svg'))
    .resize(96, 96)
    .png()
    .toBuffer();

  // 下部に "vibe-editor" を描く。SVG テキストを PNG にラスタライズ
  const labelSvg = `
<svg width="${width}" height="40" xmlns="http://www.w3.org/2000/svg">
  <text x="${width / 2}" y="26" font-family="Georgia, 'Times New Roman', serif"
        font-size="17" fill="#f5d4a8" text-anchor="middle" font-style="italic">
    vibe-editor
  </text>
</svg>`;
  const labelBuf = await sharp(Buffer.from(labelSvg)).png().toBuffer();

  // RGB raw 出力（sharp は BMP 書き出し非対応なので手動で 24bit BMP 化する）
  const { data, info } = await sharp({
    create: { width, height, channels: 4, background }
  })
    .composite([
      { input: iconBuf, left: Math.floor((width - 96) / 2), top: 90 },
      { input: labelBuf, left: 0, top: 200 }
    ])
    .flatten({ background })
    .raw()
    .toBuffer({ resolveWithObject: true });

  writeFileSync(join(root, 'installerSidebar.bmp'), rawToBmp(data, info.width, info.height));
  console.log('[icons] wrote installerSidebar.bmp (164x314)');
}

/** 150×57 のヘッダ BMP を生成 */
async function generateNsisHeader() {
  const width = 150;
  const height = 57;
  const background = { r: 26, g: 26, b: 46, alpha: 1 };

  const iconBuf = await sharp(join(root, 'icon.svg'))
    .resize(40, 40)
    .png()
    .toBuffer();

  const { data, info } = await sharp({
    create: { width, height, channels: 4, background }
  })
    .composite([{ input: iconBuf, left: width - 48, top: 8 }])
    .flatten({ background })
    .raw()
    .toBuffer({ resolveWithObject: true });

  writeFileSync(join(root, 'installerHeader.bmp'), rawToBmp(data, info.width, info.height));
  console.log('[icons] wrote installerHeader.bmp (150x57)');
}

/**
 * RGB raw ピクセル (sharp の .raw() 出力、1ch=8bit、RGB順) を
 * 24bit 無圧縮 BMP に変換する。
 *
 * BMP の仕様:
 *   - 14 バイト BITMAPFILEHEADER
 *   - 40 バイト BITMAPINFOHEADER
 *   - ピクセルデータは BGR 順、下から上、行は 4 バイトアラインでパディング
 */
function rawToBmp(rgb, width, height) {
  const bytesPerRow = width * 3;
  const padding = (4 - (bytesPerRow % 4)) % 4;
  const rowStride = bytesPerRow + padding;
  const pixelArraySize = rowStride * height;
  const fileSize = 14 + 40 + pixelArraySize;

  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt16LE(0, 6); // reserved
  buf.writeUInt16LE(0, 8); // reserved
  buf.writeUInt32LE(54, 10); // offset to pixel data

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14); // header size
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // 正値 = 下から上
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // compression (BI_RGB)
  buf.writeUInt32LE(pixelArraySize, 34); // image size
  buf.writeInt32LE(2835, 38); // X ppm (72 dpi)
  buf.writeInt32LE(2835, 42); // Y ppm (72 dpi)
  buf.writeUInt32LE(0, 46); // colors used
  buf.writeUInt32LE(0, 50); // important colors

  // Pixel data: BGR、下から上
  let offset = 54;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 3;
      buf[offset++] = rgb[srcIdx + 2]; // B
      buf[offset++] = rgb[srcIdx + 1]; // G
      buf[offset++] = rgb[srcIdx + 0]; // R
    }
    offset += padding;
  }

  return buf;
}

main().catch((err) => {
  console.error('[icons] failed:', err);
  process.exit(1);
});
