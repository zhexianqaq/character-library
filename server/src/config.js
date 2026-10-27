import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_DIR = path.resolve(here, '..');
export const PROJECT_DIR = path.resolve(SERVER_DIR, '..');
export const WEB_DIR = path.join(PROJECT_DIR, 'web');

/* ────────────────────────────────────────────────────────────
   存储分两层：
   数据  = 媒体原件 + 索引库，放进大容量机械盘（E 盘），丢了不可重建
   缓存  = 缩略图 / 预览图 / 上传临时区，放 SSD（D 盘），丢了随时能重建
   相对路径（media.rel_path）都是相对 DATA_DIR 的，换盘不影响索引
   ──────────────────────────────────────────────────────────── */
export const DATA_DIR = process.env.CL_DATA_DIR || 'E:\\CharacterLibrary';
export const CACHE_DIR = process.env.CL_CACHE_DIR || path.join(PROJECT_DIR, '.cache');

export const CATALOG_DIR = path.join(DATA_DIR, '.catalog');
export const DB_FILE = path.join(CATALOG_DIR, 'library.db');

export const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
export const PREVIEW_DIR = path.join(CACHE_DIR, 'preview');
export const INBOX_DIR = path.join(CACHE_DIR, 'inbox');

/* 视频自定义封面（从某一帧抽出来的图）。
   放在数据盘而不是缓存盘：这是用户挑出来的画面，清缓存不该把它清掉，
   而且备份脚本会连目录一起拷走（缓存盘那两个目录从来不进备份）。 */
export const POSTER_DIR = path.join(DATA_DIR, '.covers');

export const PORT = Number(process.env.PORT || 7788);
export const HOST = '127.0.0.1';

export const THUMB_WIDTH = 420;
export const PREVIEW_WIDTH = 1400;

export const ffmpegPath = 'C:\\Users\\35155\\.local\\bin\\ffmpeg.exe';
export const ffprobePath = 'C:\\Users\\35155\\.local\\bin\\ffprobe.exe';

export function ensureDirs() {
  for (const d of [DATA_DIR, CATALOG_DIR, CACHE_DIR, THUMB_DIR, PREVIEW_DIR, INBOX_DIR, POSTER_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 缩略图缓存分桶，避免单目录塞入上万文件 */
export function cachePathFor(size, mediaId) {
  const base = size === 'preview' ? PREVIEW_DIR : THUMB_DIR;
  return path.join(base, String(mediaId % 256), `${mediaId}.webp`);
}

/** 自定义封面分桶规则与缩略图一致（同一个 id 落在同一个桶） */
export function posterPathFor(mediaId) {
  return path.join(POSTER_DIR, String(mediaId % 256), `${mediaId}.webp`);
}

/** 把角色名变成安全的目录名 */
export function slugify(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60) || 'unnamed';
}

/** 启动时确认数据盘在位，否则直接报清楚，不要让它悄悄建到 C 盘 */
export function assertStorageReady() {
  const parent = path.dirname(DATA_DIR);
  if (!fs.existsSync(parent)) {
    throw new Error(
      `数据盘未就绪：${DATA_DIR}\n` +
        `请确认移动硬盘已连接，或用环境变量 CL_DATA_DIR 指向新的数据目录。`
    );
  }
  ensureDirs();
}
