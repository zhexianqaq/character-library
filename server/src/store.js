import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR, slugify } from './config.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.jfif', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.m4v', '.flv', '.ts', '.mpg', '.mpeg', '.3gp']);

export function kindOfExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  return null;
}

export function absPathOf(relPath) {
  return path.join(DATA_DIR, ...String(relPath).split('/'));
}

export function safeFileName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 100) || 'file';
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

/** 在 baseRel 目录下找一个不冲突的子目录名 */
export async function uniqueDirName(baseRel, wanted) {
  const base = slugify(wanted);
  let candidate = base;
  let i = 2;
  for (;;) {
    const rel = baseRel ? `${baseRel}/${candidate}` : candidate;
    if (!fs.existsSync(absPathOf(rel))) return candidate;
    candidate = `${base}-${i}`;
    i += 1;
  }
}

async function hashAndCopy(srcAbs, tmpPath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(srcAbs);
    const ws = fs.createWriteStream(tmpPath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  return hash.digest('hex');
}

async function hashBuffer(buf, tmpPath) {
  await fsp.writeFile(tmpPath, buf);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把外部文件复制进库：library/<角色目录>/<sha前10位>_<原名>
 * 用内容哈希做前缀，既避免重名覆盖，也方便将来查重。
 */
export async function importFileFromPath(srcAbs, relDir) {
  const fileName = safeFileName(path.basename(srcAbs));
  const ext = extOf(fileName);
  const kind = kindOfExt(ext);
  if (!kind) return null;

  const dir = absPathOf(relDir);
  await fsp.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}${ext}`);
  let sha;
  try {
    sha = await hashAndCopy(srcAbs, tmp);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  return finalize(tmp, dir, fileName, ext, kind, sha, relDir);
}

export async function importFileFromBuffer(buf, relDir, originalName) {
  const fileName = safeFileName(originalName);
  const ext = extOf(fileName);
  const kind = kindOfExt(ext);
  if (!kind) return null;

  const dir = absPathOf(relDir);
  await fsp.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}${ext}`);
  const sha = await hashBuffer(buf, tmp);
  return finalize(tmp, dir, fileName, ext, kind, sha, relDir);
}

/**
 * 跨盘移动：rename 只能在同一卷内用。
 * 缓存盘（D）→ 数据盘（E）会抛 EXDEV，必须降级成复制+删源。
 */
async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, dst);
      await fsp.unlink(src).catch(() => {});
    } else {
      throw err;
    }
  }
}

async function finalize(tmp, dir, fileName, ext, kind, sha, relDir) {
  const target = path.join(dir, `${sha.slice(0, 10)}_${fileName}`);
  await moveFile(tmp, target);
  const stat = await fsp.stat(target);
  const relPath = path.relative(DATA_DIR, target).split(path.sep).join('/');

  let width = null;
  let height = null;
  if (kind === 'image') {
    const dims = await readImageDims(target);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  }
  return { relPath, fileName, ext, kind, bytes: stat.size, sha256: sha, width, height, relDir };
}

/**
 * 采纳一个已经落在同盘的临时文件：算哈希后直接 rename 进库，
 * 不再复制一遍 —— 上传大视频时这一步差别很大。
 */
export async function adoptFile(tmpAbs, relDir, originalName) {
  const fileName = safeFileName(originalName);
  const ext = extOf(fileName);
  const kind = kindOfExt(ext);
  if (!kind) {
    await fsp.unlink(tmpAbs).catch(() => {});
    return null;
  }

  const dir = absPathOf(relDir);
  await fsp.mkdir(dir, { recursive: true });

  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(tmpAbs);
    rs.on('data', (c) => hash.update(c));
    rs.on('error', reject);
    rs.on('end', resolve);
  });
  const sha = hash.digest('hex');
  return finalize(tmpAbs, dir, fileName, ext, kind, sha, relDir);
}

export async function readImageDims(abs) {
  try {
    const m = await sharp(abs, { failOn: 'none' }).metadata();
    if (!m.width || !m.height) return null;
    const o = m.orientation ?? 1;
    const swap = o >= 5 && o <= 8;
    return { width: swap ? m.height : m.width, height: swap ? m.width : m.height };
  } catch {
    return null;
  }
}

/** 删除库内文件（只在库目录内，不碰外部路径） */
export async function removeLibraryFile(relPath) {
  const abs = absPathOf(relPath);
  const rel = path.relative(DATA_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  await fsp.unlink(abs).catch(() => {});
  return true;
}

/** 删除角色目录（媒体清空后调用） */
export async function removeDir(relDir) {
  const dir = absPathOf(relDir);
  const rel = path.relative(DATA_DIR, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return true;
}
