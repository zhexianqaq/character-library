/**
 * 备份数据盘：索引库快照 + 全部媒体原件 → D:\CharacterLibrary-Backup\<时间戳>\
 *
 * 用法：
 *   node tools/backup.mjs              保留最近 5 份
 *   node tools/backup.mjs --keep 10    保留最近 10 份
 *
 * 说明：
 * - 索引库用 SQLite 的 VACUUM INTO 做快照，服务开着也能拿到一致副本（含 WAL 里的改动）
 * - 媒体按目录整体复制，跨盘（E → D）复制，不受单盘故障影响
 * - 复制完会核对文件数与字节数，不一致直接报错，不写 MANIFEST
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, DB_FILE } from '../server/src/config.js';

// 依赖装在 server/ 下，从那里解析（tools/ 自身没有 node_modules）
const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

const DEST_ROOT = process.env.CL_BACKUP_DIR || 'D:\\CharacterLibrary-Backup';
const keepIdx = process.argv.indexOf('--keep');
const KEEP = keepIdx > 0 ? Number(process.argv[keepIdx + 1]) || 5 : 5;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function walk(dir) {
  let files = 0;
  let bytes = 0;
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
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files += 1;
        const st = await fs.stat(p).catch(() => null);
        if (st) bytes += st.size;
      }
    }
  }
  return { files, bytes };
}

const t0 = Date.now();
const label = stamp();
const dest = path.join(DEST_ROOT, label);
await fs.mkdir(dest, { recursive: true });

console.log(`数据目录  ${DATA_DIR}`);
console.log(`备份到    ${dest}\n`);

// 1) 索引库快照
const dbSnap = path.join(dest, '.catalog', 'library.db');
await fs.mkdir(path.dirname(dbSnap), { recursive: true });
const db = new Database(DB_FILE);
db.exec(`VACUUM INTO '${dbSnap.replace(/'/g, "''")}'`);
const integrity = db.prepare('PRAGMA integrity_check').get();
const counts = {
  characters: db.prepare('SELECT COUNT(*) c FROM characters').get().c,
  packs: db.prepare('SELECT COUNT(*) c FROM packs').get().c,
  media: db.prepare('SELECT COUNT(*) c FROM media').get().c,
  shelves: db.prepare('SELECT COUNT(*) c FROM shelves').get().c,
};
db.close();
const dbStat = await fs.stat(dbSnap);
console.log(`索引库    ${counts.characters} 角色 / ${counts.packs} 图包 / ${counts.media} 媒体`);
console.log(`          快照 ${(dbStat.size / 1024 / 1024).toFixed(1)} MB，integrity=${Object.values(integrity)[0]}`);

// 2) 媒体原件（不含 .catalog）
const srcMedia = { files: 0, bytes: 0 };
for (const entry of await fs.readdir(DATA_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '.catalog') continue;
  const from = path.join(DATA_DIR, entry.name);
  const to = path.join(dest, entry.name);
  await fs.cp(from, to, { recursive: true });
  const stat = await walk(from);
  srcMedia.files += stat.files;
  srcMedia.bytes += stat.bytes;
  console.log(`复制      ${entry.name.padEnd(10)} ${stat.files} 个文件 / ${(stat.bytes / 1024 / 1024).toFixed(1)} MB`);
}

// 3) 核对（备份目录里除 .catalog/library.db 外，应与源一致）
const dstAll = await walk(dest);
const dstMedia = { files: dstAll.files - 1, bytes: dstAll.bytes - dbStat.size };
if (srcMedia.files !== dstMedia.files || srcMedia.bytes !== dstMedia.bytes) {
  console.error(
    `\n✗ 校验失败：源 ${srcMedia.files} 个 / ${srcMedia.bytes} 字节，备份 ${dstMedia.files} 个 / ${dstMedia.bytes} 字节`
  );
  process.exit(1);
}

const manifest = [
  `备份时间   ${new Date().toLocaleString('zh-CN')}`,
  `源目录     ${DATA_DIR}`,
  `媒体文件   ${dstMedia.files} 个`,
  `媒体字节   ${dstMedia.bytes}`,
  `索引快照   library.db  ${dbStat.size} 字节`,
  `索引内容   ${counts.shelves} 个库 / ${counts.characters} 角色 / ${counts.packs} 图包 / ${counts.media} 媒体`,
  `完整性     ${Object.values(integrity)[0]}`,
  '',
  '恢复方法：把本目录下的所有内容（含 .catalog）拷回 E:\\CharacterLibrary 覆盖即可。',
].join('\n');
await fs.writeFile(path.join(dest, 'MANIFEST.txt'), manifest, 'utf8');

console.log(`\n✓ 校验通过：${dstMedia.files} 个文件 / ${(dstMedia.bytes / 1024 / 1024).toFixed(1)} MB，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

// 4) 只保留最近 N 份
const all = (await fs.readdir(DEST_ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
  .map((e) => e.name)
  .sort()
  .reverse();
for (const old of all.slice(KEEP)) {
  await fs.rm(path.join(DEST_ROOT, old), { recursive: true, force: true });
  console.log(`清理旧备份 ${old}`);
}
console.log(`\n当前保留 ${Math.min(all.length, KEEP)} 份：${all.slice(0, KEEP).join(', ')}`);
