/**
 * 图包目录同步：让磁盘上的文件夹跟上数据库里的图包。
 *
 * 背景：改名图包以前只改 `packs.title`，目录还是旧名；「移动到图包」只改
 * `media.pack_id`，文件留在原来的目录里 —— 久了磁盘就和界面对不上。
 *
 * 这里的规矩：
 *   - **只移动 / 改文件名，绝不删除文件**；唯一会删的是「已经空了的目录」
 *   - 目标重名一律加 `-1`、`-2`，不覆盖任何已有文件
 *   - 每搬一个文件立刻写库；写库失败就把文件搬回去
 *   - 真跑（dryRun=false）时写 `.catalog/sync-journal/<时间>.jsonl`，出问题能照着回滚
 *   - 空图包不建目录（只有名字、没有素材的包不占磁盘）
 *   - 磁盘上没有记录的文件一律不动，只在报告里计数
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, slugify } from './config.js';
import { absPathOf, moveFile } from './store.js';

const TYPE_DIR = { image: '图片', video: '视频', file: '文件' };
const typeDirOf = (kind) => TYPE_DIR[kind] || '图片';

const dirOf = (rel) => String(rel).split('/').slice(0, -1).join('/');
const baseOf = (rel) => String(rel).split('/').pop();
const TYPE_NAMES = new Set(['图片', '视频', '文件']);
/**
 * 媒体所在的「图包目录」：<条目>/[小库]/<图包>。
 * 媒体总是放在 <图包>/图片|视频|文件 里，所以要看两层；万一没有类型层就用它自己那层。
 */
const packDirOf = (rel) => {
  const dir = dirOf(rel);
  const last = dir.split('/').pop();
  return TYPE_NAMES.has(last) ? dir.split('/').slice(0, -1).join('/') : dir;
};

/** 同一时刻只允许一个同步在跑（按钮连点 / 同时开两个窗口） */
let running = false;

/** 目录里已经有同名文件时换一个名字，绝不覆盖 */
function freeName(absDir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let cand = name;
  let i = 1;
  while (fs.existsSync(path.join(absDir, cand))) {
    cand = `${stem}-${i}${ext}`;
    i += 1;
    if (i > 999) return `${stem}-${Date.now()}${ext}`;
  }
  return cand;
}

/** 数一个目录下真正有多少个文件（改名时报告用） */
function countFiles(relDir) {
  let n = 0;
  const walk = (abs) => {
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) walk(full);
      else n += 1;
    }
  };
  walk(absPathOf(relDir));
  return n;
}

/** 条目目录下「文件名 → 相对路径」索引：记录丢了路径时按名字找回来 */
function buildNameIndex(charDirAbs) {
  const map = new Map();
  const walk = (abs) => {
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(DATA_DIR, full).split(path.sep).join('/');
      const arr = map.get(e.name);
      if (arr) arr.push(rel);
      else map.set(e.name, [rel]);
    }
  };
  walk(charDirAbs);
  return map;
}

/**
 * 这个图包目录是不是「独享」的 —— 里面的文件必须正好是这个包的。
 *
 * 整目录 rename 只能用在独享目录上：同一层月份目录里可能还躺着别的图包的文件，
 * 直接 rename 会把别人的文件一起搬走（v3.45 第一次同步实测踩到，38 条记录找不到文件）。
 */
function dirIsExclusive(relDir, rows) {
  const want = new Map();
  for (const r of rows) {
    const n = baseOf(r.rel_path);
    want.set(n, (want.get(n) || 0) + 1);
  }
  let extra = 0;
  const walk = (abs) => {
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const c = want.get(e.name) || 0;
      if (c > 0) want.set(e.name, c - 1);
      else extra += 1;
    }
  };
  walk(absPathOf(relDir));
  let left = 0;
  for (const v of want.values()) left += v;
  return extra === 0 && left === 0;
}

/** 这些目录不删：条目根目录、未分类及其子目录（app 建出来的固定结构） */
function protectedDir(rel, charDir) {
  if (rel === charDir) return true;
  const rest = rel.slice(charDir.length).replace(/^\//, '');
  if (!rest) return true;
  return rest.split('/')[0] === '未分类';
}

/** 空目录才删（rmdir 对非空目录会失败，天然安全） */
function pruneEmptyDirs(dirs, charDirs) {
  let removed = 0;
  const list = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  for (const rel of list) {
    const owner = charDirs.find((c) => rel === c || rel.startsWith(`${c}/`));
    if (!owner || protectedDir(rel, owner)) continue;
    try {
      fs.rmdirSync(absPathOf(rel));
      removed += 1;
    } catch {
      /* 非空 / 已经没了 / 被占用 —— 都留着 */
    }
  }
  return removed;
}

function openJournal() {
  const dir = path.join(DATA_DIR, '.catalog', 'sync-journal');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.jsonl`);
  const fd = fs.openSync(file, 'a');
  try {
    const olds = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .slice(0, -5);
    for (const n of olds) fs.unlinkSync(path.join(dir, n));
  } catch {
    /* 清理失败无所谓 */
  }
  return {
    file,
    write(obj) {
      try {
        fs.writeSync(fd, `${JSON.stringify(obj)}\n`);
      } catch {
        /* 日志写不进去不影响搬运 */
      }
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 单个图包：目录跟着标题走（只处理「所有媒体都在同一个目录」的简单情况）。
 * 复杂情况（散在多个目录）交给 syncPackDirs 合并。
 */
export async function renamePackDir(db, packId) {
  const pack = db
    .prepare('SELECT p.*, c.dir_slug FROM packs p JOIN characters c ON c.id = p.character_id WHERE p.id = ?')
    .get(packId);
  if (!pack) return { ok: false, reason: 'missing' };
  const rows = db.prepare('SELECT id, rel_path FROM media WHERE pack_id = ?').all(packId);
  if (!rows.length) return { ok: true, skipped: 'empty' };

  const dirs = [...new Set(rows.map((r) => packDirOf(r.rel_path)))];
  const parent = [pack.dir_slug, pack.category || ''].filter(Boolean).join('/');
  const target = `${parent}/${slugify(pack.title)}`;
  if (dirs.length === 1 && dirs[0] === target) return { ok: true, unchanged: true };
  // 散在多个目录 / 父级不对 / 目标已存在 —— 不在这里硬来，交给同步按钮
  if (dirs.length !== 1) return { ok: false, reason: 'scattered', dirs: dirs.length };
  const cur = dirs[0];
  if (dirOf(cur) !== parent) return { ok: false, reason: 'parent' };
  if (fs.existsSync(absPathOf(target))) return { ok: false, reason: 'exists' };
  // 同条目搬包只改库，文件还留在原目录里 —— 这个目录可能同时住着别的包的文件。
  // 直接整目录 rename 会把它们一起搬走（v3.45 踩过），这里必须核对「独享」。
  if (!dirIsExclusive(cur, rows)) return { ok: false, reason: 'shared' };

  await fsp.rename(absPathOf(cur), absPathOf(target));
  const upd = db.prepare('UPDATE media SET rel_path = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(target + r.rel_path.slice(cur.length), r.id);
  });
  try {
    tx();
  } catch (err) {
    await fsp.rename(absPathOf(target), absPathOf(cur)).catch(() => {});
    throw err;
  }
  return { ok: true, from: cur, to: target, files: rows.length };
}

/**
 * 全量同步。dryRun=true 只算不动（给前端弹确认框用）。
 *
 * 顺序：图包目录 → 未归包素材 → 清空空目录。
 * 简单改名走「整目录 rename + 批量改 rel_path」，散包才逐个文件搬。
 */
export async function syncPackDirs(db, { dryRun = true, scope = null } = {}) {
  if (running) throw Object.assign(new Error('同步正在进行中'), { code: 'SYNC_BUSY' });
  running = true;
  // 增量模式：只处理这些图包 / 媒体 / 条目，别的一概不碰
  const packIds = scope && Array.isArray(scope.packIds) ? [...new Set(scope.packIds.map(Number).filter(Boolean))] : null;
  const mediaIds = scope && Array.isArray(scope.mediaIds) ? [...new Set(scope.mediaIds.map(Number).filter(Boolean))] : null;
  const scoped = !!(scope && (packIds || mediaIds));
  const journal = dryRun ? null : openJournal();

  const summary = {
    dryRun,
    packs: { scanned: 0, alreadyOk: 0, renamed: 0, merged: 0 },
    filesMoved: 0,
    loose: { items: 0, filesMoved: 0 },
    emptyPacks: 0,
    dirsRemoved: 0,
    orphanFiles: 0,
    missingFiles: 0,
    repaired: 0,
    repairs: [],
    errors: [],
    changes: [],
    journal: journal ? journal.file : null,
  };

  const charDirs = db.prepare('SELECT dir_slug FROM characters WHERE is_container = 0').all().map((r) => r.dir_slug);
  const touchedDirs = new Set();

  try {
    const packWhere = ['EXISTS (SELECT 1 FROM media m WHERE m.pack_id = p.id)'];
    const packArgs = {};
    if (packIds) {
      if (!packIds.length) {
        // 没有要处理的包：直接跳过整段
        packWhere.push('0');
      } else {
        packWhere.push(`p.id IN (${packIds.map((_, i) => `@pk${i}`).join(',')})`);
        packIds.forEach((id, i) => {
          packArgs[`pk${i}`] = id;
        });
      }
    }
    const packs = db
      .prepare(
        `SELECT p.id, p.title, p.category, c.name AS char_name, c.dir_slug
         FROM packs p JOIN characters c ON c.id = p.character_id
         WHERE ${packWhere.join(' AND ')}
         ORDER BY p.id`
      )
      .all(packArgs);
    summary.emptyPacks = scoped
      ? 0
      : db
          .prepare(`SELECT COUNT(*) n FROM packs p WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.pack_id = p.id)`)
          .get().n;

    const mediaStmt = db.prepare('SELECT id, rel_path, kind FROM media WHERE pack_id = ? ORDER BY id');
    const updPath = db.prepare('UPDATE media SET rel_path = ? WHERE id = ?');

    /* ---------- 先修「记录还在、按路径找不到文件」的 ----------
       上一次同步如果搬过目录，别的包的记录可能还指着旧路径。
       按文件名在条目目录里找一次：只有一个同名文件就认领，多个就不猜。 */
    const allRows = db
      .prepare('SELECT m.id, m.rel_path, m.pack_id FROM media m ORDER BY m.id')
      .all()
      .filter(
        (r) =>
          !scoped ||
          (mediaIds && mediaIds.includes(r.id)) ||
          (packIds && packIds.includes(r.pack_id))
      );
    const missingRows = allRows.filter((r) => !fs.existsSync(absPathOf(r.rel_path)));
    if (missingRows.length) {
      const dirOfChar = new Map(
        db.prepare('SELECT id, dir_slug FROM characters WHERE is_container = 0').all().map((c) => [c.id, c.dir_slug])
      );
      const idToChar = new Map(db.prepare('SELECT id, character_id FROM media').all().map((m) => [m.id, m.character_id]));
      const indexes = new Map();
      for (const r of missingRows) {
        const dirSlug = dirOfChar.get(idToChar.get(r.id));
        if (!dirSlug) {
          summary.errors.push({ mediaId: r.id, from: r.rel_path, reason: '条目已不存在' });
          continue;
        }
        if (!indexes.has(dirSlug)) indexes.set(dirSlug, buildNameIndex(absPathOf(dirSlug)));
        const name = baseOf(r.rel_path);
        const hits = (indexes.get(dirSlug).get(name) || []).filter((p) => p !== r.rel_path);
        if (hits.length === 1) {
          summary.repaired += 1;
          if (!dryRun) updPath.run(hits[0], r.id);
          if (summary.repairs.length < 20) summary.repairs.push({ mediaId: r.id, from: r.rel_path, to: hits[0] });
        } else {
          summary.errors.push({
            mediaId: r.id,
            from: r.rel_path,
            reason: hits.length ? `同名文件有 ${hits.length} 个，没敢自动认领` : '文件不在磁盘上',
          });
        }
      }
    }

    // 本轮已被认领的目标目录（Windows 大小写不敏感）
    const claimed = new Set();

    for (const p of packs) {
      summary.packs.scanned += 1;
      const rows = mediaStmt.all(p.id);
      // 图包目录（不是「图片」那一层）；散包就是好几个
      const dirs = [...new Set(rows.map((r) => packDirOf(r.rel_path)))];
      const parent = [p.dir_slug, p.category || ''].filter(Boolean).join('/');

      // 目标目录名：slug(标题)。
      // 被别人占了的判断有两层：本轮已认领的、磁盘上已存在但不是这个包现在的目录 ——
      // 后者很关键：同名的旧目录里可能躺着别的包的文件，硬并进去就成了两个包共用一个文件夹。
      const baseName = slugify(p.title);
      let target = `${parent}/${baseName}`;
      let n = 2;
      // 「被占用」= 本轮认领过，或磁盘上有同名目录且里面**有文件**。
      // 空目录不算被占：可以当目标用（直接往里搬，省一次改名）
      const nonEmpty = (rel) => {
        try {
          const abs = absPathOf(rel);
          return fs.existsSync(abs) && fs.readdirSync(abs).length > 0;
        } catch {
          return false;
        }
      };
      const taken = (t) => claimed.has(t.toLowerCase()) || (nonEmpty(t) && !dirs.includes(t));
      while (taken(target) && n < 200) {
        target = `${parent}/${baseName}-${n}`;
        n += 1;
      }
      claimed.add(target.toLowerCase());

      const pushChange = (kind, files) => {
        if (summary.changes.length >= 40) return;
        summary.changes.push({
          packId: p.id,
          title: p.title,
          owner: p.char_name,
          kind,
          from: dirs.slice(0, 4),
          to: target,
          files,
        });
      };

      // 情况一：整包只有一个目录，纯改名 —— 一次 rename 搞定
      if (dirs.length === 1 && dirs[0] !== target && dirOf(dirs[0]) === parent && dirIsExclusive(dirs[0], rows)) {
        const cur = dirs[0];
        const blocked = fs.existsSync(absPathOf(target)) && target.toLowerCase() !== cur.toLowerCase();
        if (!blocked) {
          const realFiles = countFiles(cur);
          if (dryRun) {
            summary.packs.renamed += 1;
            summary.filesMoved += realFiles;
            pushChange('rename', realFiles);
            continue;
          }
          try {
            await fsp.rename(absPathOf(cur), absPathOf(target));
            const tx = db.transaction(() => {
              for (const r of rows) updPath.run(target + r.rel_path.slice(cur.length), r.id);
            });
            try {
              tx();
            } catch (err) {
              await fsp.rename(absPathOf(target), absPathOf(cur)).catch(() => {});
              throw err;
            }
            journal?.write({ t: 'dir', from: cur, to: target });
            touchedDirs.add(cur);
            summary.packs.renamed += 1;
            summary.filesMoved += realFiles;
            pushChange('rename', realFiles);
            continue;
          } catch (err) {
            summary.errors.push({ packId: p.id, from: cur, reason: err.message || String(err) });
            continue;
          }
        }
        // 目标已经被别人占了：退化成逐个文件搬（同名加后缀，不覆盖）
      }

      // 情况二：文件散在多个目录（或目标重名）—— 逐个搬
      const moves = [];
      for (const r of rows) {
        const dir = `${target}/${typeDirOf(r.kind)}`;
        const to = `${dir}/${baseOf(r.rel_path)}`;
        if (to !== r.rel_path) moves.push({ id: r.id, from: r.rel_path, to, dir });
      }
      if (!moves.length) {
        summary.packs.alreadyOk += 1;
        continue;
      }

      if (dryRun) {
        summary.packs.merged += 1;
        summary.filesMoved += moves.length;
        pushChange('merge', moves.length);
        continue;
      }

      let moved = 0;
      for (const m of moves) {
        const fromAbs = absPathOf(m.from);
        if (!fs.existsSync(fromAbs)) {
          summary.errors.push({ mediaId: m.id, from: m.from, reason: '源文件不存在' });
          continue;
        }
        try {
          fs.mkdirSync(absPathOf(m.dir), { recursive: true });
          let to = m.to;
          if (fs.existsSync(absPathOf(to))) {
            to = `${m.dir}/${freeName(absPathOf(m.dir), baseOf(to))}`;
          }
          await moveFile(fromAbs, absPathOf(to));
          try {
            updPath.run(to, m.id);
          } catch (err) {
            await moveFile(absPathOf(to), fromAbs).catch(() => {});
            throw err;
          }
          touchedDirs.add(dirOf(m.from));
          touchedDirs.add(packDirOf(m.from));
          journal?.write({ t: 'move', mediaId: m.id, from: m.from, to });
          moved += 1;
        } catch (err) {
          summary.errors.push({ mediaId: m.id, from: m.from, reason: err.message || String(err) });
        }
      }
      summary.filesMoved += moved;
      if (moved) {
        summary.packs.merged += 1;
        pushChange('merge', moved);
      }
    }

    /* ---------- 未归包素材：收回 <条目>/未分类/图片|视频|文件 ---------- */
    const looseRows = mediaIds
      ? mediaIds.length
        ? db
            .prepare(
              `SELECT m.id, m.rel_path, m.kind, c.dir_slug
               FROM media m JOIN characters c ON c.id = m.character_id
               WHERE m.pack_id IS NULL AND m.id IN (${mediaIds.map((_, i) => `@lm${i}`).join(',')})
               ORDER BY m.id`
            )
            .all(Object.fromEntries(mediaIds.map((id, i) => [`lm${i}`, id])))
        : []
      : db
          .prepare(
            `SELECT m.id, m.rel_path, m.kind, c.dir_slug
             FROM media m JOIN characters c ON c.id = m.character_id
             WHERE m.pack_id IS NULL
             ORDER BY m.id`
          )
          .all();
    for (const m of looseRows) {
      const dir = `${m.dir_slug}/未分类/${typeDirOf(m.kind)}`;
      const to = `${dir}/${baseOf(m.rel_path)}`;
      if (to === m.rel_path) continue;
      if (dryRun) {
        summary.loose.items += 1;
        summary.loose.filesMoved += 1;
        continue;
      }
      const fromAbs = absPathOf(m.rel_path);
      if (!fs.existsSync(fromAbs)) {
        summary.errors.push({ mediaId: m.id, from: m.rel_path, reason: '源文件不存在' });
        continue;
      }
      try {
        fs.mkdirSync(absPathOf(dir), { recursive: true });
        let dst = to;
        if (fs.existsSync(absPathOf(dst))) dst = `${dir}/${freeName(absPathOf(dir), baseOf(to))}`;
        await moveFile(fromAbs, absPathOf(dst));
        try {
          updPath.run(dst, m.id);
        } catch (err) {
          await moveFile(absPathOf(dst), fromAbs).catch(() => {});
          throw err;
        }
        touchedDirs.add(dirOf(m.rel_path));
        touchedDirs.add(packDirOf(m.rel_path));
        journal?.write({ t: 'move', mediaId: m.id, from: m.rel_path, to: dst });
        summary.loose.items += 1;
        summary.loose.filesMoved += 1;
      } catch (err) {
        summary.errors.push({ mediaId: m.id, from: m.rel_path, reason: err.message || String(err) });
      }
    }

    /* ---------- 清空目录 / 数一下没人认领的文件 ---------- */
    if (dryRun && !scoped) {
      const allRows = db.prepare('SELECT rel_path FROM media').all();
      const have = new Set(allRows.map((r) => r.rel_path));
      // 记录还在、文件已经不在的（同步修不了，但要让人知道）
      for (const r of allRows) if (!fs.existsSync(absPathOf(r.rel_path))) summary.missingFiles += 1;
      for (const c of charDirs) {
        const base = absPathOf(c);
        if (!fs.existsSync(base)) continue;
        const walk = (dir) => {
          let ents = [];
          try {
            ents = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of ents) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(full);
              continue;
            }
            const rel = path.relative(DATA_DIR, full).split(path.sep).join('/');
            if (!have.has(rel)) summary.orphanFiles += 1;
          }
        };
        walk(base);
      }
    } else if (!dryRun) {
      summary.dirsRemoved = pruneEmptyDirs([...touchedDirs], charDirs);
    }
  } finally {
    journal?.close();
    running = false;
  }

  return summary;
}

/** 图包删除后清掉空目录（只删空的，文件一个不动） */
export function pruneDirsOf(relDirs, db) {
  const charDirs = db.prepare('SELECT dir_slug FROM characters WHERE is_container = 0').all().map((r) => r.dir_slug);
  return pruneEmptyDirs(relDirs, charDirs);
}
