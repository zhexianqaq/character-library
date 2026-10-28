/**
 * 生成桌面壳的窗口图标：SVG → 32bpp BMP-in-ICO（assets/icon.ico）。
 *
 * 为什么不用现成的 ico 转换库：只需要一张图，而引入依赖会让 release 构建
 * 和 Cargo.lock 都变复杂。这里用项目里已有的 sharp 渲染 SVG，然后按
 * ICO 规范手写头 —— 32bpp 无反压缩的 BMP 分支，格式简单到可以照着写。
 *
 * 为什么尺寸只做 48：Windows 会把 48 缩到标题栏 16 / 任务栏 32，
 * 显示效果够用；多尺寸要另做一套小尺寸微调，收益不大。
 *
 * 用法：node desktop/make-icon.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'assets', 'icon.ico');

// sharp 装在 server/ 下，从那里 require 才找得到
const serverRequire = createRequire(path.join(root, 'server', 'package.json'));
const sharp = serverRequire('sharp');

const SIZE = 48;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="11" fill="#1d1d1b"/>
  <rect x="10" y="10" width="12" height="12" rx="2.6" fill="#ffffff"/>
  <rect x="26" y="10" width="12" height="12" rx="2.6" fill="#ffffff" opacity="0.76"/>
  <rect x="10" y="26" width="12" height="12" rx="2.6" fill="#ffffff" opacity="0.76"/>
  <rect x="26" y="26" width="12" height="12" rx="2.6" fill="#ffffff"/>
</svg>`;

const { data, info } = await sharp(Buffer.from(SVG))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

if (info.width !== SIZE || info.height !== SIZE || info.channels !== 4) {
  throw new Error(`unexpected raster: ${info.width}x${info.height} ch=${info.channels}`);
}

// ICO 里的 BMP 是 bottom-up 的 BGRA；sharp 给的是 top-down RGBA
const xor = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  const srcRow = (SIZE - 1 - y) * SIZE * 4;
  const dstRow = y * SIZE * 4;
  for (let x = 0; x < SIZE; x++) {
    const s = srcRow + x * 4;
    const d = dstRow + x * 4;
    xor[d] = data[s + 2];
    xor[d + 1] = data[s + 1];
    xor[d + 2] = data[s];
    xor[d + 3] = data[s + 3];
  }
}

// AND 掩码：1bpp，行按 4 字节对齐。32bpp 有 alpha，掩码全 0 即可
const maskRow = Math.ceil(SIZE / 8 / 4) * 4;
const mask = Buffer.alloc(maskRow * SIZE, 0);

const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0); // biSize
dib.writeInt32LE(SIZE, 4); // biWidth
dib.writeInt32LE(SIZE * 2, 8); // biHeight：XOR + AND 两半
dib.writeUInt16LE(1, 12); // biPlanes
dib.writeUInt16LE(32, 14); // biBitCount
dib.writeUInt32LE(0, 16); // biCompression = BI_RGB
dib.writeUInt32LE(0, 20); // biSizeImage

const body = Buffer.concat([dib, xor, mask]);
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // count
header.writeUInt8(SIZE, 6); // width（48 直接用；256 才写 0）
header.writeUInt8(SIZE, 7); // height
header.writeUInt8(0, 8); // colorCount
header.writeUInt8(0, 9); // reserved
header.writeUInt16LE(1, 10); // planes
header.writeUInt16LE(32, 12); // bitCount
header.writeUInt32LE(body.length, 14); // bytesInRes
header.writeUInt32LE(22, 18); // imageOffset

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, body]));
console.log(`[ok] ${out} (${Buffer.concat([header, body]).length} B, ${SIZE}x${SIZE} 32bpp)`);
