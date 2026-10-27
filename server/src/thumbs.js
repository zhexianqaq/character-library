import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { cachePathFor, posterPathFor, THUMB_WIDTH, PREVIEW_WIDTH, ffmpegPath, ffprobePath, DATA_DIR, POSTER_DIR } from './config.js';
import { absPathOf } from './store.js';
import { getDb } from './db.js';

const execFileAsync = promisify(execFile);

// 基准（24 张真实图，420px WebP q74）：串行 19 张/秒 → 并发8+内部2线程 66 张/秒。
// 内部线程给太多会和外部并发互相争抢，2 是最优点。
sharp.concurrency(2);

/**
 * 派生图生成池。
 * 媒体库在 NVMe SSD 上，并发才是对的；早期按「移动机械盘」写的串行策略
 * 会把 8 核完全闲置（实测单张 190ms，串行吞吐 5 张/秒）。
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.THUMB_CONCURRENCY || 8));
let running = 0;
const queue = [];
const inflight = new Map();

function pump() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    running += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

/** 当前队列/并发状态，方便观察是否堵住 */
export function thumbPoolState() {
  return { running, queued: queue.length, concurrency: MAX_CONCURRENCY };
}

function widthFor(size) {
  return size === 'preview' ? PREVIEW_WIDTH : THUMB_WIDTH;
}

async function writeBufferAtomic(dst, buf) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dst);
}

async function makeImageDerivative(srcAbs, dst, width) {
  // 不预先 metadata()：省一次磁盘随机读，withoutEnlargement 自己会处理小图
  const buf = await sharp(srcAbs, { failOn: 'none', limitInputPixels: 268402689 })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 74, effort: 2 })
    .toBuffer();
  await writeBufferAtomic(dst, buf);
}

async function probeVideo(srcAbs) {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        srcAbs,
      ],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
    );
    const j = JSON.parse(stdout || '{}');
    const s = (j.streams && j.streams[0]) || {};
    const durSec = Number(s.duration ?? (j.format && j.format.duration) ?? 0);
    return {
      width: Number(s.width) || null,
      height: Number(s.height) || null,
      durationMs: durSec > 0 ? Math.round(durSec * 1000) : null,
    };
  } catch {
    return { width: null, height: null, durationMs: null };
  }
}

async function makeVideoDerivative(srcAbs, dst, width, durationMs) {
  const seek = durationMs && durationMs > 3000 ? Math.min(durationMs / 1000 * 0.1, 8) : 0;
  const tmpJpg = `${dst}.${process.pid}.frame.jpg`;
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-v', 'error',
        '-ss', String(seek),
        '-i', srcAbs,
        '-frames:v', '1',
        '-vf', `scale=${width}:-2:flags=lanczos`,
        '-q:v', '3',
        '-y', tmpJpg,
      ],
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
    );
    const buf = await sharp(tmpJpg).webp({ quality: 74, effort: 2 }).toBuffer();
    await writeBufferAtomic(dst, buf);
  } finally {
    await fs.unlink(tmpJpg).catch(() => {});
  }
}

function loadMediaRow(mediaId) {
  return getDb()
    .prepare(
      `SELECT m.*, c.dir_slug AS char_dir FROM media m
       JOIN characters c ON c.id = m.character_id WHERE m.id = ?`
    )
    .get(mediaId);
}

export function absolutePathOf(row) {
  return absPathOf(row.rel_path);
}

/**
 * 有自定义封面就直接用它。
 *
 * 文件不在了（比如手动删了 .covers）就当没设过：宁可回落到自动首帧，
 * 也不要把一个 404 的路径丢给 `<img>`。
 */
export function posterPathIfAny(row) {
  if (!row || row.kind !== 'video' || !row.poster_rel) return null;
  const abs = absPathOf(row.poster_rel);
  return existsSync(abs) ? abs : null;
}

/** 返回派生图路径；不存在则排队生成 */
export async function getDerivative(mediaId, size = 'thumb') {
  const row = loadMediaRow(mediaId);
  if (!row) return null;
  // 视频设过封面 → 缩略图就是那一帧，别再抽首帧（抽了也不会被用到）
  if (size === 'thumb') {
    const poster = posterPathIfAny(row);
    if (poster) return poster;
  }
  const dst = cachePathFor(size, row.id);
  if (existsSync(dst)) return dst;

  const key = `${row.id}:${size}`;
  if (inflight.has(key)) return inflight.get(key);

  const job = schedule(async () => {
    if (existsSync(dst)) return dst;
    const srcAbs = absolutePathOf(row);
    const width = widthFor(size);

    if (row.kind === 'image') {
      await makeImageDerivative(srcAbs, dst, width);
    } else if (row.kind === 'video') {
      const info = await probeVideo(srcAbs);
      await makeVideoDerivative(srcAbs, dst, width, info.durationMs);
      if (info.width && info.height) {
        getDb()
          .prepare(
            `UPDATE media SET width = COALESCE(width, ?), height = COALESCE(height, ?),
             duration_ms = COALESCE(duration_ms, ?) WHERE id = ?`
          )
          .run(info.width, info.height, info.durationMs, row.id);
      }
    } else {
      throw new Error('unsupported kind: ' + row.kind);
    }

    getDb().prepare('UPDATE media SET thumb_state = 1 WHERE id = ?').run(row.id);
    return dst;
  });

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 把视频某一帧存成这个媒体的封面。
 *
 * 用户在播放器上停到哪里就抽哪里（播放中也可以，`currentTime` 是点击那一刻的值）。
 * 抽帧用输入侧 `-ss`：ffmpeg 会从最近的关键帧解码到目标时间，够精确又不慢。
 */
export async function capturePoster(mediaId, atSec) {
  const row = loadMediaRow(mediaId);
  if (!row) {
    const err = new Error('媒体不存在');
    err.status = 404;
    throw err;
  }
  if (row.kind !== 'video') {
    const err = new Error('只有视频可以设封面');
    err.status = 400;
    throw err;
  }

  const srcAbs = absolutePathOf(row);
  if (!existsSync(srcAbs)) {
    const err = new Error('文件已丢失，无法抽帧');
    err.status = 410;
    throw err;
  }

  // 时长优先用库里已有的（入库时 ffprobe 过），没有再探一次
  const durationMs = Number(row.duration_ms) || (await probeVideo(srcAbs)).durationMs || 0;
  const dur = durationMs / 1000;
  let at = Number(atSec);
  if (!Number.isFinite(at) || at < 0) at = 0;
  // 最后一帧常常是黑场，也别让 ffmpeg 读到超出范围
  if (dur > 0) at = Math.min(at, Math.max(0, dur - 0.06));

  const dst = posterPathFor(row.id);
  const tmpJpg = `${dst}.${process.pid}.frame.jpg`;
  await fs.mkdir(path.dirname(dst), { recursive: true });
  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-v', 'error',
        '-ss', at.toFixed(3),
        '-i', srcAbs,
        '-frames:v', '1',
        '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
        '-q:v', '3',
        '-y', tmpJpg,
      ],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }
    );
    const buf = await sharp(tmpJpg).webp({ quality: 74, effort: 2 }).toBuffer();
    await writeBufferAtomic(dst, buf);
  } finally {
    await fs.unlink(tmpJpg).catch(() => {});
  }

  const rel = path.relative(DATA_DIR, dst).split(path.sep).join('/');
  const posterMs = Math.round(at * 1000);
  getDb().prepare('UPDATE media SET poster_rel = ?, poster_ms = ?, thumb_state = 1 WHERE id = ?').run(rel, posterMs, row.id);
  return { posterMs, posterRel: rel };
}

/**
 * 启动时清一遍没人认领的封面文件。
 *
 * 删媒体 / 删图包 / 删条目都是直接删行，`.covers` 里的 webp 不会跟着消失。
 * 这些文件很小，但不该越积越多；启动时对一遍 id 就够（几百个 stat，可以忽略）。
 */
export async function sweepOrphanPosters() {
  const db = getDb();
  let dirs = [];
  try {
    dirs = await fs.readdir(POSTER_DIR, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const bucket = path.join(POSTER_DIR, d.name);
    const files = await fs.readdir(bucket).catch(() => []);
    for (const f of files) {
      const m = /^(\d+)\.webp$/.exec(f);
      if (!m) continue;
      if (db.prepare('SELECT 1 FROM media WHERE id = ?').get(Number(m[1]))) continue;
      await fs.unlink(path.join(bucket, f)).catch(() => {});
      removed += 1;
    }
    // 桶空了就一起收掉，别在数据盘上留一堆空目录
    await fs.rmdir(bucket).catch(() => {});
  }
  return { removed };
}

/** 恢复默认封面：删掉抽出来的那一帧，缩略图回落到自动首帧 */
export async function clearPoster(mediaId) {
  const row = loadMediaRow(mediaId);
  if (!row) {
    const err = new Error('媒体不存在');
    err.status = 404;
    throw err;
  }
  if (row.poster_rel) await fs.unlink(absPathOf(row.poster_rel)).catch(() => {});
  getDb().prepare('UPDATE media SET poster_rel = NULL, poster_ms = NULL WHERE id = ?').run(row.id);
  return { ok: true };
}

export const warmState = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  currentId: null,
  startedAt: null,
  finishedAt: null,
};

/** 后台预热全部缩略图；机械硬盘上串行跑，不抢用户浏览的 IO */
export async function warmAll({ size = 'thumb' } = {}) {
  if (warmState.running) return { ok: false, error: '预热已在进行' };
  const db = getDb();
  const rows = db
    .prepare(`SELECT id FROM media WHERE kind IN ('image','video') AND thumb_state = 0 ORDER BY kind DESC, id`)
    .all();

  Object.assign(warmState, {
    running: true,
    total: rows.length,
    done: 0,
    failed: 0,
    currentId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  try {
    const BATCH = MAX_CONCURRENCY * 2;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      await Promise.all(
        slice.map(async (r) => {
          warmState.currentId = r.id;
          try {
            await getDerivative(r.id, size);
            warmState.done += 1;
          } catch {
            warmState.failed += 1;
            db.prepare('UPDATE media SET thumb_state = 2 WHERE id = ?').run(r.id);
          }
        })
      );
    }
    return { ok: true, total: rows.length, done: warmState.done, failed: warmState.failed };
  } finally {
    warmState.running = false;
    warmState.currentId = null;
    warmState.finishedAt = new Date().toISOString();
  }
}
