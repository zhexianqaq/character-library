/**
 * 增量同步执行器（v3.46）。
 *
 * 只读 fs_ops：
 *   - pending / failed  → 应用到磁盘（补空目录、搬同条目移动、解散归位、重试删除）
 *   - done 且没校验过   → 核对结果（按**当前状态**核，不按历史目标，避免把后续改名改回去）
 *   - 核不过           → 自动修一次，再不过记 failed 留队列
 *
 * 全程不扫全库：范围来自日志里涉及的图包 / 媒体。
 */
import fs from 'node:fs';
import { slugify } from './config.js';
import { absPathOf, removeLibraryFile } from './store.js';
import { syncPackDirs, pruneDirsOf } from './pack-sync.js';
import { refreshCharacter, refreshPack } from './db.js';
import { setOpStatus, markVerified, startRun, finishRun } from './ops-log.js';

const TYPE_NAMES = new Set(['图片', '视频', '文件']);
const dirOf = (rel) => String(rel).split('/').slice(0, -1).join('/');
const packDirOf = (rel) => {
  const dir = dirOf(rel);
  return TYPE_NAMES.has(dir.split('/').pop()) ? dir.split('/').slice(0, -1).join('/') : dir;
};
const parse = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

/** 图包当前应该在的目录（按数据库里的最新状态算） */
function packTarget(db, packId) {
  const p = db
    .prepare(
      `SELECT p.title, p.category, c.dir_slug FROM packs p
       JOIN characters c ON c.id = p.character_id WHERE p.id = ?`
    )
    .get(packId);
  if (!p) return null;
  return [p.dir_slug, p.category || '', slugify(p.title)].filter(Boolean).join('/');
}

function mediaRow(db, id) {
  return db
    .prepare(
      `SELECT m.id, m.rel_path, m.pack_id, m.kind, c.dir_slug
       FROM media m JOIN characters c ON c.id = m.character_id WHERE m.id = ?`
    )
    .get(id);
}

/** 这个媒体现在该待的目录；包没了 / 未归包都落到「未分类」 */
function mediaTarget(db, m) {
  if (!m) return null;
  const sub = m.kind === 'video' ? '视频' : m.kind === 'file' ? '文件' : '图片';
  if (m.pack_id) {
    const t = packTarget(db, m.pack_id);
    if (t) return `${t}/${sub}`;
  }
  return `${m.dir_slug}/未分类/${sub}`;
}

/**
 * 校验一条日志声称的结果 —— 用**当前数据库状态**判断。
 * 不用 payload 里的历史目标：改名 A→B→C 之后，A→B 那条应该算过，而不是被改回 B。
 */
function verifyOp(db, op) {
  const p = parse(op.payload);
  const ok = () => ({ ok: true });
  const bad = (reason) => ({ ok: false, reason });

  switch (op.action) {
    case 'pack.create': {
      const target = packTarget(db, op.entity_id);
      if (!target) return ok(); // 建完又删了，没什么可校验
      const n = db.prepare('SELECT COUNT(*) n FROM media WHERE pack_id = ?').get(op.entity_id).n;
      if (n) return ok(); // 有素材就一定有目录（上传时建的）
      return fs.existsSync(absPathOf(target)) ? ok() : bad('新建图包的目录还没建出来');
    }
    case 'pack.rename': {
      const target = packTarget(db, op.entity_id);
      if (!target) return ok();
      const rows = db.prepare('SELECT rel_path FROM media WHERE pack_id = ?').all(op.entity_id);
      for (const r of rows) {
        if (!fs.existsSync(absPathOf(r.rel_path))) return bad('有媒体文件不在磁盘上');
        if (packDirOf(r.rel_path) !== target) return bad('图包目录名还没跟上标题');
      }
      if (!rows.length && !fs.existsSync(absPathOf(target))) return bad('空图包目录不存在');
      return ok();
    }
    case 'pack.dissolve': {
      for (const id of p.mediaIds || []) {
        const m = mediaRow(db, id);
        if (!m) continue;
        if (!fs.existsSync(absPathOf(m.rel_path))) return bad('解散的素材有文件不在磁盘上');
        if (!m.rel_path.startsWith(`${m.dir_slug}/未分类/`)) return bad('解散的素材还没收进「未分类」');
      }
      return ok();
    }
    case 'media.move': {
      for (const id of p.ids || []) {
        const m = mediaRow(db, id);
        if (!m) continue;
        if (!fs.existsSync(absPathOf(m.rel_path))) return bad('素材文件不在磁盘上');
        const target = mediaTarget(db, m);
        if (target && dirOf(m.rel_path) !== target) return bad('素材还没搬到目标目录');
      }
      return ok();
    }
    case 'media.delete':
    case 'pack.delete': {
      for (const it of p.items || []) {
        if (it && it.path && fs.existsSync(absPathOf(it.path))) return bad('还有文件没删掉');
      }
      return ok();
    }
    case 'media.add': {
      for (const id of p.ids || []) {
        const m = mediaRow(db, id);
        if (!m) continue;
        if (!fs.existsSync(absPathOf(m.rel_path))) return bad('刚入库的文件不见了');
      }
      return ok();
    }
    case 'character.rename': {
      const c = db.prepare('SELECT dir_slug FROM characters WHERE id = ?').get(op.entity_id);
      if (!c) return ok();
      return fs.existsSync(absPathOf(c.dir_slug)) ? ok() : bad('条目目录不存在');
    }
    case 'character.delete': {
      if (p.dir && fs.existsSync(absPathOf(p.dir))) return bad('条目目录还在');
      return ok();
    }
    case 'dir.prune': {
      for (const rel of p.dirs || []) {
        const abs = absPathOf(rel);
        if (!fs.existsSync(abs)) continue;
        // 目录里又有了文件（用户后来往里放东西）→ 本来就该留着，不算失败
        let n = 0;
        try {
          n = fs.readdirSync(abs).length;
        } catch {
          continue;
        }
        if (n === 0) return bad('空目录还在');
      }
      return ok();
    }
    default:
      return ok(); // alias / convert 之类不涉及磁盘
  }
}

/** 从日志里汇总这次要碰的范围 */
function collectScope(ops) {
  const packIds = new Set();
  const mediaIds = new Set();
  const dirs = [];
  const creates = [];
  const deleteItems = [];
  for (const op of ops) {
    const p = parse(op.payload);
    if (op.action === 'pack.create') creates.push(op);
    else if (op.action === 'pack.rename') packIds.add(op.entity_id);
    else if (op.action === 'pack.dissolve') (p.mediaIds || []).forEach((id) => mediaIds.add(id));
    else if (op.action === 'media.move') {
      (p.ids || []).forEach((id) => mediaIds.add(id));
      if (p.toPackId) packIds.add(p.toPackId);
    } else if (op.action === 'media.delete' || op.action === 'pack.delete') {
      deleteItems.push(...(p.items || []));
    } else if (op.action === 'dir.prune') dirs.push(...(p.dirs || []));
  }
  return { packIds: [...packIds], mediaIds: [...mediaIds], dirs, creates, deleteItems };
}

/** 建空目录：新建图包在同步时补出来 */
function ensurePackDirs(db, creates) {
  for (const op of creates) {
    const target = packTarget(db, op.entity_id);
    if (!target || fs.existsSync(absPathOf(target))) continue;
    // 有素材的包交给 sync 一起处理：这里先把目标目录建出来，
    // 会让「改名 / 合并」以为目标被别人占了，白白多出个 -2 后缀
    const n = db.prepare('SELECT COUNT(*) n FROM media WHERE pack_id = ?').get(op.entity_id).n;
    if (n) continue;
    try {
      fs.mkdirSync(absPathOf(target), { recursive: true });
    } catch {
      /* 建不出来就留给校验记 failed */
    }
  }
}

/** 重试删除：文件删掉之后把对应的媒体记录也删掉，别留下指向空气的条目 */
async function retryDeletes(db, items) {
  let done = 0;
  const failed = [];
  const chars = new Set();
  const packs = new Set();
  const getRow = db.prepare('SELECT id, rel_path, character_id, pack_id FROM media WHERE id = ?');
  const delRow = db.prepare('DELETE FROM media WHERE id = ?');

  for (const it of items) {
    if (!it || !it.path) continue;
    if (!fs.existsSync(absPathOf(it.path))) {
      // 文件已经没了：只把残留记录收掉
      const row = it.id ? getRow.get(it.id) : null;
      if (row && row.rel_path === it.path) {
        delRow.run(row.id);
        chars.add(row.character_id);
        if (row.pack_id) packs.add(row.pack_id);
        done += 1;
      }
      continue;
    }
    const r = await removeLibraryFile(it.path);
    if (!r.ok && !r.alreadyGone) {
      failed.push(it.path);
      continue;
    }
    const row = it.id ? getRow.get(it.id) : null;
    if (row && row.rel_path === it.path) {
      delRow.run(row.id);
      chars.add(row.character_id);
      if (row.pack_id) packs.add(row.pack_id);
    }
    done += 1;
  }
  for (const cid of chars) refreshCharacter(cid);
  for (const pid of packs) refreshPack(pid);
  return { done, failed };
}

/**
 * 执行增量同步。
 * dryRun=true 只统计（给弹窗用），不动磁盘、不改状态。
 */
export async function applyOps(db, { dryRun = false } = {}) {
  const open = db.prepare(`SELECT * FROM fs_ops WHERE status IN ('pending','failed') ORDER BY id`).all();
  const fresh = db.prepare(`SELECT * FROM fs_ops WHERE status = 'done' AND verified_at IS NULL ORDER BY id`).all();

  const scopeInfo = collectScope(open);
  const groups = {
    create: open.filter((o) => o.action === 'pack.create').length,
    rename: open.filter((o) => o.action === 'pack.rename').length,
    dissolve: open.filter((o) => o.action === 'pack.dissolve').length,
    move: scopeInfo.mediaIds.length,
    delete: scopeInfo.deleteItems.length,
    prune: scopeInfo.dirs.length,
  };

  if (dryRun) {
    return {
      dryRun: true,
      pending: open.length,
      unverified: fresh.length,
      groups,
      ops: open.slice(0, 40).map((o) => ({
        id: o.id,
        action: o.action,
        entity: o.entity,
        entityId: o.entity_id,
        status: o.status,
        reason: o.reason,
        payload: parse(o.payload),
      })),
    };
  }

  const runId = startRun(db, 'incremental');
  let filesMoved = 0;
  let dirsRemoved = 0;
  let repaired = 0;
  let failed = 0;

  /* 1) 新建图包的空目录 */
  ensurePackDirs(db, scopeInfo.creates);

  /* 2) 按范围重算（搬同条目移动 / 解散归位 / 改名没跟上的） */
  if (scopeInfo.packIds.length || scopeInfo.mediaIds.length) {
    try {
      const r = await syncPackDirs(db, {
        dryRun: false,
        scope: { packIds: scopeInfo.packIds, mediaIds: scopeInfo.mediaIds },
      });
      filesMoved += r.filesMoved || 0;
      dirsRemoved += r.dirsRemoved || 0;
    } catch {
      failed += 1;
    }
  }

  /* 3) 重试没删掉的文件 */
  if (scopeInfo.deleteItems.length) {
    const del = await retryDeletes(db, scopeInfo.deleteItems);
    filesMoved += del.done;
    failed += del.failed.length;
  }

  /* 4) 指定要收的空目录 */
  if (scopeInfo.dirs.length) {
    dirsRemoved += pruneDirsOf(scopeInfo.dirs, db);
  }

  /* 5) 校验：本次应用的 + 上次之后没校验的 */
  const toVerify = [...open, ...fresh];
  const results = new Map(toVerify.map((op) => [op.id, verifyOp(db, op)]));
  const bad = toVerify.filter((op) => !results.get(op.id).ok);

  // 核不过的：把涉及的实体再修一遍，然后重核一次
  if (bad.length) {
    const fix = { packIds: new Set(), mediaIds: new Set() };
    for (const op of bad) {
      const p = parse(op.payload);
      if (op.action === 'pack.rename' || op.action === 'pack.create') fix.packIds.add(op.entity_id);
      if (op.action === 'pack.dissolve') (p.mediaIds || []).forEach((id) => fix.mediaIds.add(id));
      if (op.action === 'media.move') {
        (p.ids || []).forEach((id) => fix.mediaIds.add(id));
        if (p.toPackId) fix.packIds.add(p.toPackId);
      }
    }
    if (fix.packIds.size || fix.mediaIds.size) {
      try {
        const r = await syncPackDirs(db, {
          dryRun: false,
          scope: { packIds: [...fix.packIds], mediaIds: [...fix.mediaIds] },
        });
        filesMoved += r.filesMoved || 0;
        dirsRemoved += r.dirsRemoved || 0;
      } catch {
        /* 修不动就留在 failed */
      }
      for (const op of bad) {
        const again = verifyOp(db, op);
        results.set(op.id, again);
        if (again.ok) repaired += 1;
      }
    }
  }

  /* 6) 回写状态 */
  const okIds = [];
  let verified = 0;
  for (const op of toVerify) {
    const v = results.get(op.id) || { ok: false, reason: '未校验' };
    if (v.ok) {
      if (op.status !== 'done') setOpStatus(db, op.id, 'done');
      okIds.push(op.id);
      verified += 1;
    } else {
      setOpStatus(db, op.id, 'failed', v.reason || '校验没过');
      failed += 1;
    }
  }
  markVerified(db, okIds);

  finishRun(db, runId, {
    applied: open.length,
    verified,
    repaired,
    failed,
    filesMoved,
    dirsRemoved,
    note: `pending ${open.length} / fresh ${fresh.length}`,
  });

  return {
    dryRun: false,
    runId,
    applied: open.length,
    checked: toVerify.length,
    verified,
    repaired,
    failed,
    filesMoved,
    dirsRemoved,
    groups,
    left: db.prepare(`SELECT COUNT(*) n FROM fs_ops WHERE status IN ('pending','failed')`).get().n,
  };
}
