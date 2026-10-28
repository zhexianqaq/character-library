/**
 * 一次性导入：把外部表情包目录整体搬进「表情包」。
 * 每个子目录 = 一个图包；文件名里带 .gif.jpg 这种转格式产物也照收。
 *
 * 用法（在 server 目录下）：
 *   node src/import-emoji.mjs <库ID> "<源目录>"
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, nowIso, refreshCharacter, refreshCharacterPacks, ensureShelfContainer } from './db.js';
import { importFileFromPath, hashFileOf, kindOfExt, uniqueDirName, absPathOf } from './store.js';
import { slugify } from './config.js';
import { getDerivative } from './thumbs.js';

const shelfId = Number(process.argv[2]);
const sourceRoot = process.argv[3];
if (!shelfId || !sourceRoot) {
  console.error('用法: node src/import-emoji.mjs <库ID> "<源目录>"');
  process.exit(1);
}

/** 目录名 → 图包名：三个来源各给一个好念的名字 */
function packTitleOf(dirName) {
  const n = dirName.toLowerCase();
  if (n.includes('emoji-related')) return '精选表情';
  if (n.includes('marketface')) return '商城表情';
  if (n.includes('personal')) return '个人表情';
  return String(dirName).replace(/^\d+[_-]/, '').replace(/_?提取的.*$/, '').trim() || dirName;
}

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

const db = getDb();
const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
if (!shelf) {
  console.error('库不存在:', shelfId);
  process.exit(1);
}
const container = ensureShelfContainer(shelfId);
const ts = nowIso();

const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(sourceRoot, e.name));
const groups = dirs.length ? [] : [{ dir: sourceRoot, title: path.basename(sourceRoot) }];
for (const d of dirs) groups.push({ dir: d, title: packTitleOf(path.basename(d)) });

const findPack = db.prepare('SELECT id FROM packs WHERE character_id = ? AND title = ?');
const insertPack = db.prepare(
  `INSERT INTO packs(character_id, title, sort_order, created_at)
   VALUES(?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
);
const insertMedia = db.prepare(
  `INSERT INTO media(character_id, pack_id, kind, rel_path, file_name, ext, bytes, sha256, width, height, anim, sort_order, created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM media WHERE pack_id IS ?),?)`
);
const findBySha = db.prepare('SELECT id FROM media WHERE character_id = ? AND sha256 = ?');

console.log(`\n[表情包] ${shelf.name} · 容器条目 ${container.id} (${container.dir_slug})`);
console.log(`        源目录 ${sourceRoot}`);
console.log(`        共 ${groups.length} 个来源目录\n`);

let totalAdded = 0;
let totalSkipped = 0;
const addedIds = [];
const startedAt = Date.now();

for (const g of groups) {
  const files = (await walk(g.dir)).filter((f) => kindOfExt(path.extname(f)));
  let packId;
  const hit = findPack.get(container.id, g.title);
  if (hit) {
    packId = hit.id;
  } else {
    packId = Number(insertPack.run(container.id, g.title, container.id, ts).lastInsertRowid);
  }
  // 重跑时沿用已有目录，别分裂出「个人表情-2」
  const plain = slugify(g.title);
  const packSlug = (await fs
    .access(absPathOf(`${container.dir_slug}/${plain}`))
    .then(() => plain)
    .catch(() => null)) || (await uniqueDirName(container.dir_slug, g.title));
  const relDir = `${container.dir_slug}/${packSlug}/图片`;

  console.log(`— 「${g.title}」 ${files.length} 个文件 → ${relDir}`);

  let done = 0;
  for (const file of files) {
    const fileName = path.basename(file);
    done += 1;
    try {
      const sha = await hashFileOf(file);
      if (findBySha.get(container.id, sha)) {
        totalSkipped += 1;
        continue;
      }
      const saved = await importFileFromPath(file, relDir);
      if (!saved) {
        totalSkipped += 1;
        continue;
      }
      const info = insertMedia.run(
        container.id,
        packId,
        saved.kind,
        saved.relPath,
        fileName,
        saved.ext,
        saved.bytes,
        saved.sha256,
        saved.width,
        saved.height,
        saved.anim ? 1 : 0,
        packId,
        ts
      );
      addedIds.push(Number(info.lastInsertRowid));
      totalAdded += 1;
    } catch (err) {
      totalSkipped += 1;
      console.error(`   ! ${fileName}: ${err.message || err}`);
    }
    if (done % 25 === 0 || done === files.length) {
      process.stdout.write(`\r   ${done}/${files.length}  新增 ${totalAdded}  跳过 ${totalSkipped}   `);
    }
  }
  console.log('');
}

refreshCharacterPacks(container.id);
refreshCharacter(container.id);

console.log(`\n入库完成：新增 ${totalAdded}，跳过 ${totalSkipped}，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`开始生成缩略图（${addedIds.length} 张）…`);

let thumbs = 0;
let thumbFail = 0;
for (const id of addedIds) {
  try {
    await getDerivative(id, 'thumb');
    thumbs += 1;
  } catch {
    thumbFail += 1;
  }
  if (thumbs % 50 === 0) process.stdout.write(`\r   ${thumbs}/${addedIds.length}   `);
}
console.log(`\n缩略图完成：${thumbs} 张，失败 ${thumbFail} 张`);
const stat = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM media WHERE character_id = ?').get(container.id);
console.log(`库里现在：${stat.n} 个素材，${(stat.b / 1024 ** 2).toFixed(0)} MB\n`);
process.exit(0);
