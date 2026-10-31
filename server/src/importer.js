import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { getDb, nowIso, refreshCharacter, refreshCharacterPacks } from './db.js';
import { entryNameKey, storedEntryName } from './entry-name.js';
import { importFileFromPath, uniqueDirName, kindOfExt, removeLibraryFile, absPathOf } from './store.js';
import { splitTitleTags } from './pack-tags.js';
import { getDerivative } from './thumbs.js';

/**
 * 删掉已经空掉的多层子目录（只删子目录，根目录保留）。
 * 返回删掉的目录数；有任何文件残留的目录都原样留着。
 */
async function pruneEmptyDirs(root) {
  let removed = 0;
  const walk = async (dir) => {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 1;
    }
    let remaining = 0;
    for (const e of entries) {
      if (!e.isDirectory()) {
        remaining += 1;
        continue;
      }
      const sub = path.join(dir, e.name);
      const left = await walk(sub);
      if (left === 0) {
        try {
          await fs.rmdir(sub);
          removed += 1;
        } catch {
          remaining += 1;
        }
      } else {
        remaining += 1;
      }
    }
    return remaining;
  };
  await walk(root);
  return removed;
}

const POST_RE = /^(.+?)-(\d{8})-(\d{6,})(?:_(\d{1,3}))?$/;
const DATE_RE = /(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/;

/** 从文件名推断所属月份：优先「名称-YYYYMMDD-帖子ID」，退化为任意 YYYYMMDD */
export function monthOfFileName(fileName) {
  const stem = String(fileName).replace(/\.[^.]+$/, '');
  const m = POST_RE.exec(stem);
  if (m) return `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}`;
  const d = DATE_RE.exec(stem);
  if (d) return `${d[1]}-${d[2]}`;
  return null;
}

export function monthTitle(month) {
  if (!month) return '未分类';
  const [y, mm] = month.split('-');
  return `${y} 年 ${Number(mm)} 月`;
}

/** 从目录名拆出显示名与账号：'Aqua水淼(aqua_cosplay)' */
export function parseDirName(dir) {
  const m = /^(.*)\(([^()]+)\)\s*$/.exec(dir);
  if (m && m[1].trim()) return { name: m[1].trim(), account: m[2].trim() };
  return { name: String(dir).trim(), account: null };
}

async function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * 把外部一个角色目录整体导入自己的库。
 * 按月份自动建图包；已存在同 sha256 的媒体会跳过（可重复执行）。
 *
 * moveSource = true 时是「搬」而不是「抄」：每个文件在**确认库里已有一份完整副本**之后
 * 才删源文件（复制失败 / 尺寸对不上 / 重复判定却在库里找不到实体，一律保留源文件）。
 * 跑完会把源目录里已经空掉的多层子目录清掉，**根目录本身保留**。
 */
export async function importCharacterDir({
  shelfId,
  sourceDir,
  name,
  account,
  moveSource = false,
  onProgress,
}) {
  const db = getDb();
  const dirName = path.basename(sourceDir);
  const parsed = parseDirName(dirName);
  const finalName = storedEntryName(name || parsed.name);
  const finalAccount = account !== undefined ? account : parsed.account;
  if (!finalName) throw new Error('条目名不能为空');
  const dup = db
    .prepare(
      `SELECT id, name FROM characters
        WHERE shelf_id = ? AND is_container = 0 AND name_key = ? ORDER BY id LIMIT 1`
    )
    .get(shelfId, entryNameKey(finalName));
  if (dup) {
    const err = new Error(`这个库里已经有「${dup.name}」了（条目 ${dup.id}），没有新建，源文件也没动`);
    err.code = 'DUPLICATE_ENTRY';
    err.existingId = dup.id;
    throw err;
  }

  // 外部导入只收图片 / 视频：正文文件（txt / epub）不进这个流程
  const files = (await walkFiles(sourceDir)).filter((f) =>
    ['image', 'video'].includes(kindOfExt(path.extname(f)))
  );
  if (!files.length) throw new Error('该目录下没有可导入的图片或视频');

  // 五层目录：角色集 / 角色 / 图包 / 图片|视频 / 文件
  const shelfRow = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
  const shelfSlug = await uniqueDirName('', shelfRow ? shelfRow.name : '角色集');
  const charSlug = await uniqueDirName(shelfSlug, finalName);
  const baseRel = `${shelfSlug}/${charSlug}`;
  const ts = nowIso();

  const charId = Number(
    db
      .prepare(
        `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, name_key, name_legacy_dup, sort_order, created_at, updated_at)
         VALUES(?,?,?,?,?,?,0,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?)`
      )
      .run(shelfId, finalName, finalAccount, '', baseRel, entryNameKey(finalName), shelfId, ts, ts).lastInsertRowid
  );

  const packByMonth = new Map();
  const packDirCache = new Map();

  function ensurePack(month) {
    const key = month || '0000-00';
    if (packByMonth.has(key)) return packByMonth.get(key);
    let pack;
    const row = db.prepare('SELECT id, title FROM packs WHERE character_id = ? AND month IS ?').get(charId, month);
    if (row) {
      pack = { id: row.id, title: row.title };
    } else {
      const title = monthTitle(month);
      const id = Number(
        db
          .prepare(
            `INSERT INTO packs(character_id, title, month, sort_order, created_at, tags)
             VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?,?)`
          )
          // 图包标签带上新条目名：外部导入的包也要能在标签池里被搜到
          .run(charId, title, month, charId, ts, JSON.stringify([...new Set([...splitTitleTags(title), finalName])]))
          .lastInsertRowid
      );
      pack = { id, title };
    }
    packByMonth.set(key, pack);
    return pack;
  }

  async function relDirFor(pack, kind) {
    let packRel = packDirCache.get(pack.id);
    if (!packRel) {
      const slug = await uniqueDirName(baseRel, pack.title);
      packRel = `${baseRel}/${slug}`;
      packDirCache.set(pack.id, packRel);
    }
    return `${packRel}/${kind === 'image' ? '图片' : '视频'}`;
  }

  const insertMedia = db.prepare(
    `INSERT INTO media(character_id, pack_id, kind, rel_path, file_name, ext, bytes, sha256, width, height, anim, sort_order, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM media WHERE pack_id=?),?)`
  );
  const findBySha = db.prepare('SELECT id, rel_path, bytes FROM media WHERE character_id = ? AND sha256 = ?');

  let done = 0;
  let skipped = 0;
  let moved = 0;
  const keptSources = [];
  const added = [];
  const thumbJobs = [];

  /** 库里那份确认可用（存在且字节数一致）才允许删源文件；任何不确定都留着 */
  const libCopyIsSafe = (relPath, bytes) => {
    if (!relPath) return false;
    const abs = absPathOf(relPath);
    try {
      return statSync(abs).size === bytes;
    } catch {
      return false;
    }
  };

  const dropSource = async (abs, bytes) => {
    try {
      const st = await fs.stat(abs);
      // 导入期间源文件被改过（尺寸变了）就不动它，宁可留一份
      if (bytes && st.size !== bytes) {
        keptSources.push(abs);
        return false;
      }
      await fs.unlink(abs);
      moved += 1;
      return true;
    } catch {
      keptSources.push(abs);
      return false;
    }
  };

  for (const file of files) {
    const fileName = path.basename(file);
    const ext = path.extname(fileName).toLowerCase();
    const kind = kindOfExt(ext);
    if (!kind || kind === 'file') continue;

    const month = monthOfFileName(fileName);
    const pack = ensurePack(month);
    const relDir = await relDirFor(pack, kind);

    let saved;
    try {
      saved = await importFileFromPath(file, relDir);
    } catch {
      continue;
    }
    if (!saved) continue;

    const existing = findBySha.get(charId, saved.sha256);
    if (existing) {
      // 重复文件：删掉刚复制进来的这一份。刚写完的文件常被杀软 / 索引短暂占用，
      // 隔 1.2s 再试一次；还删不掉就留着，但要如实报出来（不丢数据，只是多一份）
      let del = await removeLibraryFile(saved.relPath);
      if (!del.ok && !del.alreadyGone) {
        await new Promise((r) => setTimeout(r, 1200));
        del = await removeLibraryFile(saved.relPath);
        if (!del.ok && !del.alreadyGone) {
          console.warn(`[import] 重复文件删不掉：${saved.relPath}（${del.code || del.error}）`);
        }
      }
      // 搬家模式：库里原本就有同内容，确认那条记录的文件还在，源文件可以删
      if (moveSource && libCopyIsSafe(existing.rel_path, saved.bytes)) {
        await dropSource(file, saved.bytes);
      } else if (moveSource) {
        keptSources.push(file);
      }
      skipped += 1;
      done += 1;
      if (onProgress) onProgress({ done, total: files.length, name: fileName, skipped: true });
      continue;
    }

    const info = insertMedia.run(
      charId,
      pack.id,
      kind,
      saved.relPath,
      fileName,
      ext,
      saved.bytes,
      saved.sha256,
      saved.width,
      saved.height,
      saved.anim ? 1 : 0,
      pack.id,
      ts
    );
    const newId = Number(info.lastInsertRowid);
    added.push(newId);
    thumbJobs.push(getDerivative(newId, 'thumb').catch(() => {}));
    // 搬模式：确认库里的副本字节数一致才删源
    if (moveSource) await dropSource(file, saved.bytes);
    done += 1;
    if (onProgress) onProgress({ done, total: files.length, name: fileName });
  }

  await Promise.all(thumbJobs);
  const stat = refreshCharacter(charId);
  // 搬完之后把源目录里空掉的多层子目录清掉（根目录保留，免得把用户给的路径整个删了）
  let prunedDirs = 0;
  if (moveSource) prunedDirs = await pruneEmptyDirs(sourceDir);
  return {
    characterId: charId,
    dirSlug: baseRel,
    name: finalName,
    files: files.length,
    added: added.length,
    skipped,
    moved,
    keptSources,
    prunedDirs,
    ...stat,
  };
}
