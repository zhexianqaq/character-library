import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, nowIso, refreshCharacter, refreshCharacterPacks } from './db.js';
import { importFileFromPath, uniqueDirName, kindOfExt, removeLibraryFile } from './store.js';
import { getDerivative } from './thumbs.js';

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
 */
export async function importCharacterDir({ shelfId, sourceDir, name, account, onProgress }) {
  const db = getDb();
  const dirName = path.basename(sourceDir);
  const parsed = parseDirName(dirName);
  const finalName = name || parsed.name;
  const finalAccount = account !== undefined ? account : parsed.account;

  const files = (await walkFiles(sourceDir)).filter((f) => kindOfExt(path.extname(f)));
  if (!files.length) throw new Error('该目录下没有可导入的图片或视频');

  // 五层目录：角色库 / 角色 / 图包 / 图片|视频 / 文件
  const shelfRow = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
  const shelfSlug = await uniqueDirName('', shelfRow ? shelfRow.name : '角色库');
  const charSlug = await uniqueDirName(shelfSlug, finalName);
  const baseRel = `${shelfSlug}/${charSlug}`;
  const ts = nowIso();

  const charId = Number(
    db
      .prepare(
        `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, sort_order, created_at, updated_at)
         VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?)`
      )
      .run(shelfId, finalName, finalAccount, '', baseRel, shelfId, ts, ts).lastInsertRowid
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
            `INSERT INTO packs(character_id, title, month, sort_order, created_at)
             VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
          )
          .run(charId, title, month, charId, ts).lastInsertRowid
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
    `INSERT INTO media(character_id, pack_id, kind, rel_path, file_name, ext, bytes, sha256, width, height, sort_order, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM media WHERE pack_id=?),?)`
  );
  const findBySha = db.prepare('SELECT id FROM media WHERE character_id = ? AND sha256 = ?');

  let done = 0;
  let skipped = 0;
  const added = [];
  const thumbJobs = [];

  for (const file of files) {
    const fileName = path.basename(file);
    const ext = path.extname(fileName).toLowerCase();
    const kind = kindOfExt(ext);
    if (!kind) continue;

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

    if (findBySha.get(charId, saved.sha256)) {
      await removeLibraryFile(saved.relPath);
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
      pack.id,
      ts
    );
    const newId = Number(info.lastInsertRowid);
    added.push(newId);
    thumbJobs.push(getDerivative(newId, 'thumb').catch(() => {}));
    done += 1;
    if (onProgress) onProgress({ done, total: files.length, name: fileName });
  }

  await Promise.all(thumbJobs);
  const stat = refreshCharacter(charId);
  return { characterId: charId, dirSlug: baseRel, name: finalName, files: files.length, added: added.length, skipped, ...stat };
}
