import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_DIR = path.resolve(here, '..');
export const PROJECT_DIR = path.resolve(SERVER_DIR, '..');
export const WEB_DIR = path.join(PROJECT_DIR, 'web');

/* ────────────────────────────────────────────────────────────
   存储分两层：
   数据  = 媒体原件 + 索引库，丢了不可重建
   缓存  = 缩略图 / 预览图 / 上传临时区，跟项目走（<项目>/.cache），丢了随时能重建
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

/**
 * 找可执行文件：环境变量 → 本机已知路径（保持不变，别让 winget 之类的 shim 顶掉）→ PATH。
 * 别写死某个用户的绝对路径：换台机器 / 换个用户，整条视频链路就哑了。
 */
function resolveBinary(envKey, name, knownPath) {
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (knownPath && fs.existsSync(knownPath)) return knownPath;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return name; // 交给系统 PATH，真没有时 execFile 会报 ENOENT（错误信息里有命令名）
}

// 便携安装常把 ffmpeg 放进 ~/.local/bin，用 homedir 拼出来，不写死用户名
const homeBin = (name) => path.join(os.homedir(), '.local', 'bin', name);
export const ffmpegPath = resolveBinary('CL_FFMPEG', 'ffmpeg', homeBin('ffmpeg.exe'));
export const ffprobePath = resolveBinary('CL_FFPROBE', 'ffprobe', homeBin('ffprobe.exe'));

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

/** Windows 保留设备名：带扩展名也一样不能用（CON.mp4 也是坏的） */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把任意名字变成一段 Windows 能安全落盘的目录名 / 文件名词干。
 *
 * 两条常被忽略的规则：
 *   1. 结尾的空格和点会被系统悄悄吃掉 —— "a." 和 "a" 落到磁盘是同一个名字，两个条目会撞车；
 *   2. CON / PRN / AUX / NUL / COM1-9 / LPT1-9 是设备名，建目录会直接失败。
 *
 * 只作用于**新起的名字**：已存在的目录名存在 `characters.dir_slug` 里，不会再经这里重算，
 * 所以这条规则不会让老目录「改名」。
 */
export function cleanSegment(raw, maxLen = 60) {
  let s = String(raw ?? '')
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.slice(0, Math.max(1, maxLen)).replace(/[. ]+$/g, ''); // 截断后可能又落到点上，再削一次
  if (!s || /^\.+$/.test(s)) return 'unnamed';
  if (WIN_RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/** 把条目名变成安全的目录名 */
export function slugify(name) {
  return cleanSegment(name, 60);
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
