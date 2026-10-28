/**
 * 生成窗口图标：assets/icon-source.png → assets/icon.ico（多尺寸 32bpp BMP）。
 *
 * 源图是设计稿（米白圆角方块 + 书本 + 照片卡 + 轨道星点），画布铺满、
 * 圆角半径约 22.9%（实测：左边界在第 287/1254 行才贴到 0，且曲线比正圆弧
 * 略「鼓」，是 squircle——用圆弧近似，误差 <1.2%，48px 上不到 1px）。
 *
 * 为什么要抠圆角：圆角外面是纯白背景。不抠就做成透明，标题栏在深色主题下
 * 会出现一块白角。
 *
 * 为什么每个尺寸单独加遮罩而不是先遮罩再缩：缩放会把边缘插值糊掉，
 * 而在最终尺寸上画遮罩，抗锯齿正好落在一个像素上。
 *
 * 为什么全用 32bpp BMP 而不是 PNG 压缩：壳里的解析器是手写的（不引 image
 * crate），只认未压缩 BGRA。256 那一张占 262 KB，换来的是 PE 资源、
 * Alt+Tab 大图标将来都能直接用同一份文件。
 *
 * 一套脚本生成两类图标：
 *   node desktop/make-icon.mjs                                  # 程序图标（书本）→ assets/icon.ico
 *   node desktop/make-icon.mjs assets/icon-data-source.png assets/icon-data.ico
 *
 * 两张源图是同一套设计规范：1254² 画布、铺满、圆角 23%（实测 287~288px），
 * 所以共用同一个 RADIUS_RATIO。
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const src = args[0] ? path.resolve(args[0]) : path.join(here, 'assets', 'icon-source.png');
const out = args[1] ? path.resolve(args[1]) : path.join(here, 'assets', 'icon.ico');

if (!existsSync(src)) {
  console.error(`[x] 缺少源图：${src}`);
  process.exit(1);
}

// sharp 装在 server/ 下，从那里 require 才找得到
const serverRequire = createRequire(path.join(root, 'server', 'package.json'));
const sharp = serverRequire('sharp');

// Windows 会按 DPI 挑最接近的一张：标题栏 16/24、任务栏 32/48、Alt+Tab 64+、
// 资源管理器大图标 256。全给，省得它拿 48 硬放大。
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const RADIUS_RATIO = 287 / 1254; // 实测值（两张源图分别是 287 / 288）

// 逐级减半的起点按源图实际宽度取，别写死 512 —— 换个尺寸的源图也不至于缩错
const sourceWidth = (await sharp(src).metadata()).width || 512;

/**
 * 内容占画布的比例（0.5~1，默认 1）。贴边的主体（比如角色插画）用 0.9：
 * 缩进去一点、四周补白，圆角切的就是留白而不是头发。
 * 设计稿本身就带留白的（比如书本那张）保持 1，别白缩一圈。
 */
const INSET = (() => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--inset='));
  const v = hit ? Number(hit.split('=')[1]) : 1;
  return Number.isFinite(v) && v > 0.5 && v <= 1 ? v : 1;
})();

/**
 * `--png` 让每个尺寸以 PNG 数据存进 ICO（Vista+ 支持），体积约是未压缩
 * BMP 的 1/6。只能用于**文件夹图标**这类纯 shell 场景 —— `资料库.exe` 的
 * PE 资源和壳里的 tao::Icon 都走手写 BMP 解析，喂 PNG 会读不出来。
 */
const PNG_MODE = process.argv.includes('--png');

function buildDib(bgra, size) {
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0); // biSize
  dib.writeInt32LE(size, 4); // biWidth
  dib.writeInt32LE(size * 2, 8); // biHeight：XOR + AND 两半
  dib.writeUInt16LE(1, 12); // biPlanes
  dib.writeUInt16LE(32, 14); // biBitCount
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(0, 20); // biSizeImage

  const maskRow = Math.ceil(size / 8 / 4) * 4;
  const mask = Buffer.alloc(maskRow * size, 0);

  // AND mask 必须按 alpha 写：1 = 透明，0 = 不透明。
  //
  // 之前这里全 0（「32bpp 有 alpha，mask 无所谓」）是错的：资源管理器有若干
  // 渲染路径只认 mask 不认 alpha 位（缩略图缓存、老 API、某些视图），
  // 全 0 会被当成「整块不透明」，圆角外就露出 XOR 里的 RGB —— 也就是黑边。
  for (let y = 0; y < size; y++) {
    const rowOff = (size - 1 - y) * maskRow; // mask 与 XOR 一样是 bottom-up
    for (let x = 0; x < size; x++) {
      if (bgra[(y * size + x) * 4 + 3] < 128) {
        mask[rowOff + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return Buffer.concat([dib, bgra, mask]);
}

async function renderSize(size) {
  const radius = Math.max(2, Math.round(size * RADIUS_RATIO));
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );

  // 内容占画布的比例。设计稿若有留白用 1，角色/物件贴到画布边的用 <1：
  // 贴边的图被圆角切一刀，边缘会显得「硬切」，加白边后切口落在留白上就自然了。
  const inner = Math.max(8, Math.round(size * INSET));

  // 从 512 一步缩到 16 是 32 倍，lanczos 会混叠出一圈噪点（试过，星星的
  // 白描边全变成麻点）。逐级减半让每一步都不超过 2 倍，边缘干净得多。
  let buf = await sharp(src).png().toBuffer();
  let cur = sourceWidth;
  while (cur / 2 >= inner && cur / 2 >= 16) {
    cur /= 2;
    buf = await sharp(buf).resize(cur, cur, { kernel: 'lanczos3' }).png().toBuffer();
  }

  // 先把内容缩到 inner，再铺到 size×size 的白底上居中 —— 圆角遮罩随后
  // 作用在这张白底图的外缘，切到的永远是留白，不会切到主体
  let layer = await sharp(buf).resize(inner, inner, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  if (inner !== size) {
    layer = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .composite([{ input: layer, gravity: 'center' }])
      .png()
      .toBuffer();
  }

  const { data, info } = await sharp(layer)
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }]) // 用遮罩的 alpha 乘目标 alpha
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== size || info.height !== size || info.channels !== 4) {
    throw new Error(`unexpected raster: ${info.width}x${info.height} ch=${info.channels}`);
  }

  if (PNG_MODE) {
    // PNG 自带 alpha，不需要 AND mask，也不需要 bit 位运算
    return await sharp(data, { raw: { width: size, height: size, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // ICO 里的 BMP 是 bottom-up 的 BGRA
  const bgra = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      const a = data[s + 3];
      if (a < 8) {
        // 全透明的像素不要留黑色 RGB：不认 alpha 的渲染路径会把它画成黑边。
        // 抹成白色后，即使 mask 也失效，看上去也只是「白角」而不是「黑框」。
        bgra[d] = 255;
        bgra[d + 1] = 255;
        bgra[d + 2] = 255;
        bgra[d + 3] = 0;
      } else {
        bgra[d] = data[s + 2];
        bgra[d + 1] = data[s + 1];
        bgra[d + 2] = data[s];
        bgra[d + 3] = a;
      }
    }
  }
  return buildDib(bgra, size);
}

const images = [];
for (const size of SIZES) {
  images.push({ size, dib: await renderSize(size) });
}

const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(images.length, 4);

let offset = header.length;
images.forEach(({ size, dib }, i) => {
  const p = 6 + i * 16;
  header.writeUInt8(size >= 256 ? 0 : size, p); // 256 写成 0
  header.writeUInt8(size >= 256 ? 0 : size, p + 1);
  header.writeUInt8(0, p + 2); // colorCount
  header.writeUInt8(0, p + 3); // reserved
  header.writeUInt16LE(1, p + 4); // planes
  header.writeUInt16LE(32, p + 6); // bitCount
  header.writeUInt32LE(dib.length, p + 8); // bytesInRes
  header.writeUInt32LE(offset, p + 12); // imageOffset
  offset += dib.length;
});

const ico = Buffer.concat([header, ...images.map((i) => i.dib)]);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, ico);
console.log(
  `[ok] ${out} (${Math.round(ico.length / 1024)} KB, ${SIZES.join('/')} —— ${SIZES.length} 张 32bpp)`,
);
