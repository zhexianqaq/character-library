import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR, INBOX_DIR, cleanFileSegment, slugify } from './config.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.jfif', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.m4v', '.flv', '.ts', '.mpg', '.mpeg', '.3gp']);
/**
 * 正文文件：小说库专用。
 * 只入库、能读 / 能交给系统程序打开，不生成缩略图，不参与图片瀑布流。
 */
const FILE_EXT = new Set(['.txt', '.epub', '.pdf', '.mobi', '.azw3', '.md', '.doc', '.docx']);

export function kindOfExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (FILE_EXT.has(e)) return 'file';
  return null;
}

export function absPathOf(relPath) {
  return path.join(DATA_DIR, ...String(relPath).split('/'));
}

/** 只算文件 sha256，不搬文件。查重要在入库之前做，重复文件就不必跨盘复制一遍 */
export async function hashFileOf(abs) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(abs);
    rs.on('data', (c) => hash.update(c));
    rs.on('error', reject);
    rs.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * 文件名清洗 + 限长 100。
 * **截断时必须保留扩展名**：以前直接 slice(0,100)，长标题的文件会连 ".mp4" 一起被切掉，
 * 后面 kindOfExt 认不出类型 → 当成不支持的文件处理（adoptFile 还会删源），等于把文件弄丢。
 * 设备名 / 结尾点空格由 cleanSegment 处理（CON.mp4 这类在 Windows 上也建不出来）。
 */
export function safeFileName(name) {
  return cleanFileSegment(path.basename(String(name || 'file')), 100);
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同目录里找一个没被占用的文件名：<stem>-1<ext>、<stem>-2<ext>… */
async function uniqueFileIn(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || 'file';
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('同名文件太多，找不到可用名字');
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
 * 移动一个文件。
 *
 * - 同卷优先 rename（原子）
 * - Windows 上文件被缩略图 / 杀软 / 刚关闭的播放器短暂占用会抛 EPERM/EBUSY，先重试几次
 * - 跨卷（EXDEV）降级成「复制到临时名 → 校验大小 → 原子改名 → 删源」
 *   复制中途失败不会在目标位置留下半个文件；删源失败也只当「多一份副本」回报，不丢数据
 */
export async function moveFile(src, dst, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      await fsp.rename(src, dst);
      return { mode: 'rename' };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EXDEV') break;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      await sleep(120 * (i + 1));
    }
  }

  const tmp = `${dst}.part-${process.pid}-${Date.now()}`;
  try {
    if (fs.existsSync(dst)) {
      const err = new Error('目标文件已存在');
      err.code = 'EEXIST';
      throw err;
    }
    await fsp.copyFile(src, tmp);
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(tmp)]);
    if (a.size !== b.size) throw new Error(`复制不完整（${a.size} → ${b.size} 字节）`);
    await fsp.rename(tmp, dst);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    const e = new Error(`移动文件失败：${err.message}`);
    e.code = err.code || lastErr?.code || 'MOVE_FAILED';
    throw e;
  }

  let srcLeftover = false;
  try {
    await fsp.unlink(src);
  } catch {
    // 目标已经就位，源删不掉只是多一份副本；把它报到上层，别当成功悄悄咽下去
    srcLeftover = true;
  }
  return { mode: 'copy', srcLeftover };
}

async function finalize(tmp, dir, fileName, ext, kind, sha, relDir) {
  const target = path.join(dir, `${sha.slice(0, 10)}_${fileName}`);
  if (fs.existsSync(target)) {
    // 库目录里已经有同内容同名的文件（比如索引记录被删过），复用即可，别覆盖
    await fsp.unlink(tmp).catch(() => {});
  } else {
    await moveFile(tmp, target);
  }
  const stat = await fsp.stat(target);
  const relPath = path.relative(DATA_DIR, target).split(path.sep).join('/');

  let width = null;
  let height = null;
  // anim=1 只看「真的有多帧」：gif 扩展名不等于动图，
  // 微信/QQ 导出的表情里大量 .gif 其实只有一帧（一张静态图）
  let anim = kind === 'video' ? 1 : 0;
  if (kind === 'image') {
    const meta = await readImageDims(target);
    if (meta) {
      width = meta.width;
      height = meta.height;
      if (meta.pages > 1) anim = 1;
    }
  }
  return { relPath, fileName, ext, kind, bytes: stat.size, sha256: sha, width, height, anim, relDir };
}

/**
 * 采纳一个已经落在同盘的临时文件：算哈希后直接 rename 进库，
 * 不再复制一遍 —— 上传大视频时这一步差别很大。
 */
export async function adoptFile(tmpAbs, relDir, originalName, knownSha = null) {
  const fileName = safeFileName(originalName);
  const ext = extOf(fileName);
  const kind = kindOfExt(ext);
  if (!kind) {
    // 只清理上传临时区里的文件。以前这里是无条件 unlink ——
    // 传进来的是库里已有的真实文件时（导入脚本），一次类型误判就等于删用户文件
    const abs = path.resolve(tmpAbs);
    if (abs.startsWith(path.resolve(INBOX_DIR) + path.sep)) {
      await fsp.unlink(abs).catch(() => {});
    }
    return null;
  }

  const dir = absPathOf(relDir);
  await fsp.mkdir(dir, { recursive: true });

  const sha = knownSha || (await hashFileOf(tmpAbs));
  return finalize(tmpAbs, dir, fileName, ext, kind, sha, relDir);
}

export async function readImageDims(abs) {
  try {
    const m = await sharp(abs, { failOn: 'none' }).metadata();
    if (!m.width || !m.height) return null;
    const o = m.orientation ?? 1;
    const swap = o >= 5 && o <= 8;
    return {
      width: swap ? m.height : m.width,
      height: swap ? m.width : m.height,
      // 多帧 = 真动图（gif / 动态 webp / apng）
      pages: m.pages || 1,
    };
  } catch {
    return null;
  }
}

/**
 * 把库里已有的文件挪到另一个目录。
 *
 * 以前目标已有同名文件时**直接删源**，理由是「文件名带 sha 前 10 位，同名即同内容」。
 * 10 位十六进制只有 40 bit，而且用户完全可能手动往目录里丢过一个同名文件 ——
 * 现在改成比全量 sha256：
 *   - 内容相同 → 删源，复用目标（正常去重）
 *   - 内容不同 → **绝不删源**，换个 `<名字>-1.<扩展名>` 放进去，两份都留着，并回报 `action:'renamed'`
 *
 * 返回 { relPath, action, warning }：action = moved | reused | renamed
 */
export async function relocateFile(relPath, newRelDir, hooks = {}) {
  const src = absPathOf(relPath);
  const dir = absPathOf(newRelDir);
  await fsp.mkdir(dir, { recursive: true });

  let dst = path.join(dir, path.basename(src));
  const norm = (p) => path.relative(DATA_DIR, p).split(path.sep).join('/');
  if (path.resolve(dst) === path.resolve(src)) {
    return { relPath: String(relPath).split(path.sep).join('/'), action: 'moved', warning: null };
  }
  if (!fs.existsSync(src)) {
    const err = new Error('源文件已不在磁盘上');
    err.code = 'ENOENT';
    throw err;
  }

  let action = 'moved';
  let warning = null;

  if (fs.existsSync(dst)) {
    const same = (await hashFileOf(src)) === (await hashFileOf(dst));
    if (same) {
      action = 'reused';
      try {
        await fsp.unlink(src);
      } catch (err) {
        // 目标已是同一份内容，源删不掉只是多一份副本
        warning = `内容相同的源文件删不掉（${err.code || err.message}），已保留在原目录`;
      }
    } else {
      action = 'renamed';
      dst = await uniqueFileIn(dir, path.basename(src));
      warning = `目标目录已有同名但内容不同的文件，改存为 ${path.basename(dst)}`;
    }
  }

  if (action !== 'reused') {
    // 落盘之前先把「要搬到哪」记下来，进程中途被杀也能靠它回滚
    if (typeof hooks.onTarget === 'function') await hooks.onTarget(dst);
    const moved = await moveFile(src, dst);
    if (moved.srcLeftover) warning = '目标就绪，但源文件删不掉，原目录里还留了一份副本';
  }
  return { relPath: norm(dst), action, warning };
}

/** 把文件属性里的「只读」去掉（Windows 上这是 rm 失败最常见的原因） */
async function clearReadOnlyDeep(root) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        await fsp.chmod(p, 0o666).catch(() => {});
      }
    }
  }
}

/**
 * 删除库内文件（只在库目录内，不碰外部路径）。
 * 返回结构化的结果 —— 以前是 `.catch(() => {})` + 恒 true，
 * 文件被占用 / 只读时上层照样报「已删除」，磁盘上其实还在。
 */
export async function removeLibraryFile(relPath) {
  const abs = absPathOf(relPath);
  const rel = path.relative(DATA_DIR, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'EINVAL', error: '路径不在数据目录内' };
  }

  for (let i = 0; i < 3; i += 1) {
    try {
      await fsp.unlink(abs);
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, alreadyGone: true };
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        // 只读属性 / 权限：先清只读再试；还不行就把真实错误报上去
        await fsp.chmod(abs, 0o666).catch(() => {});
        if (i < 2) {
          await sleep(150 * (i + 1));
          continue;
        }
      }
      if (err.code === 'EBUSY' && i < 2) {
        await sleep(200 * (i + 1));
        continue;
      }
      return { ok: false, code: err.code || 'ERR', error: err.message, path: abs };
    }
  }
  return { ok: false, code: 'ERR', error: '删除失败', path: abs };
}

/**
 * 删除角色目录（媒体清空后调用）。
 * 失败时返回还剩多少文件，方便人工去处理 —— 绝不吞掉错误。
 */
export async function removeDir(relDir) {
  const dir = absPathOf(relDir);
  const rel = path.relative(DATA_DIR, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'EINVAL', error: '路径不在数据目录内' };
  }

  for (let i = 0; i < 3; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, alreadyGone: true };
      if (i === 0) await clearReadOnlyDeep(dir); // 只读文件会让整个递归删除失败
      if (i < 2) {
        await sleep(200 * (i + 1));
        continue;
      }
      return {
        ok: false,
        code: err.code || 'ERR',
        error: err.message,
        path: dir,
        remaining: await countFiles(dir).catch(() => null),
      };
    }
  }
  return { ok: false, code: 'ERR', error: '删除目录失败', path: dir };
}

/** 数一下目录里还剩多少文件（报告用） */
async function countFiles(root) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else n += 1;
    }
  }
  return n;
}
