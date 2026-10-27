/**
 * 备份数据盘：索引库快照 + 全部媒体原件 → <DEST>/<时间戳>\
 *
 * 用法：
 *   node tools/backup.mjs               保留最近 5 份
 *   node tools/backup.mjs --keep 10     保留最近 10 份
 *   node tools/backup.mjs --sample 30   抽 30 个文件比内容哈希（默认 12，0 = 不比）
 *
 * 为什么这么写（2026-10-27 重写）：
 * - **先快照数据库、再复制文件**，然后**拿快照里的 media 记录逐条去备份里核对**：
 *   每条记录的 rel_path 必须存在、字节数必须等于库里的 bytes。
 *   以前只比「源目录文件数/字节数」和备份目录，既证明不了内容一致，也挡不住
 *   「快照之后新入库的文件不在备份里」这种不一致 —— 那种备份恢复出来会有打不开的条目。
 * - 写入 `<DEST>/.staging/<时间戳>/`，校验通过才改名成正式备份；
 *   失败时改成 `<时间戳>.failed` 并写 FAILURE.txt，**绝不当成一份可用备份**，
 *   也不会触发「清理旧备份」（只清带 MANIFEST.txt 的正式目录）。
 * - 数据根目录下的**散落文件**也一起备份（以前只遍历目录，E:\CharacterLibrary\library.db
 *   这种根目录文件会被跳过，而且计数校验也发现不了）。
 * - 内容一致性：全部文件比字节数，再按 --sample 抽若干文件比 sha256。
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, DB_FILE } from '../server/src/config.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

const DEST_ROOT = process.env.CL_BACKUP_DIR || 'E:\\CharacterLibrary-Backup';
const argNum = (name, def) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
};
const KEEP = Math.max(1, argNum('--keep', Number(process.env.CL_BACKUP_KEEP) || 5));
const SAMPLE = Math.max(0, argNum('--sample', Number(process.env.CL_BACKUP_SAMPLE ?? 12)));
// 同一秒内跑两次（测试里很常见）也要各占一个目录，加 -2 / -3 后缀
const NAME_RE = /^\d{8}-\d{6}(-\d+)?$/;

const t0 = Date.now();
let label = stamp();
const stageRoot = path.join(DEST_ROOT, '.staging');
let stage = path.join(stageRoot, label);
let finalDir = path.join(DEST_ROOT, label);
let finalized = false;
/** 打开着的快照连接：失败时要先关掉，否则 Windows 上目录改名会被占住 */
let snapDb = null;

async function uniqueLabel(base) {
  for (let i = 2; i < 50; i += 1) {
    const c = i === 2 ? base : `${base}-${i}`;
    if (!existsSync(path.join(DEST_ROOT, c)) && !existsSync(path.join(DEST_ROOT, `${c}.failed`))) return c;
  }
  return `${base}-${Date.now()}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function statSafe(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** 目录里所有文件（跳过 .catalog），返回 [{ abs, rel, size }] */
async function listFiles(root, skipDirNames = new Set()) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (skipDirNames.has(e.name)) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const st = await statSafe(p);
        if (st) out.push({ abs: p, rel: path.relative(root, p), size: st.size });
      }
    }
  }
  return out;
}

function sha256(abs) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(abs);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/** 正式备份目录：名字对、有 MANIFEST、不是 .failed */
async function validBackups() {
  let entries = [];
  try {
    entries = await fs.readdir(DEST_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    const dir = path.join(DEST_ROOT, e.name);
    const ok = await statSafe(path.join(dir, 'MANIFEST.txt'));
    const bad = await statSafe(path.join(dir, 'FAILURE.txt'));
    if (ok && !bad) out.push(e.name);
  }
  return out.sort().reverse();
}

async function fail(reason) {
  // 先放掉数据库句柄：Windows 上目录里只要有「未共享删除」的打开文件，改名就会失败
  if (snapDb) {
    try {
      snapDb.close();
    } catch {
      /* 忽略 */
    }
    snapDb = null;
  }
  const note = [`备份失败 ${new Date().toLocaleString('zh-CN')}`, `原因 ${reason}`, `源目录 ${DATA_DIR}`].join('\n');
  let where = stage;
  const failedDir = path.join(DEST_ROOT, `${label}.failed`);
  try {
    if (existsSync(stage)) {
      await fs.rename(stage, failedDir);
      where = failedDir;
    }
  } catch (err) {
    console.error(`  注意：失败目录改名失败（${err.code || err.message}），保留在 ${stage}`);
  }
  await fs.mkdir(where, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(where, 'FAILURE.txt'), note, 'utf8').catch(() => {});
  console.error(`\n✗ 备份失败：${reason}`);
  console.error(`  现场保留在 ${where}（不会被当成可用备份，也不影响已有备份）`);
  process.exit(1);
}

async function main() {
  label = await uniqueLabel(label);
  stage = path.join(stageRoot, label);
  finalDir = path.join(DEST_ROOT, label);
  await fs.mkdir(stage, { recursive: true });
  console.log(`数据目录  ${DATA_DIR}`);
  console.log(`备份到    ${finalDir}`);
  console.log(`暂存区    ${stage}\n`);

  // 0) 空间预检：按索引里的字节数估，宁可提前失败也不写一半
  const db0 = new Database(DB_FILE);
  db0.pragma('busy_timeout = 10000');
  const estBytes = db0.prepare('SELECT COALESCE(SUM(bytes),0) b FROM media').get().b;
  try {
    const fsStat = await fs.statfs(DEST_ROOT);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    // 留 200MB 余量：数据库快照、目录项、manifest 也要空间
    if (free < estBytes * 1.02 + 200 * 1024 * 1024) {
      return fail(`目标盘空间不足：需要约 ${fmtMB(estBytes)}，可用 ${fmtMB(free)}`);
    }
    console.log(`空间预检  需要 ${fmtMB(estBytes)} · 可用 ${fmtMB(free)}`);
  } catch {
    /* statfs 不可用就跳过预检，后面复制失败也会明确报错 */
  }
  const counts = {
    characters: db0.prepare('SELECT COUNT(*) c FROM characters').get().c,
    packs: db0.prepare('SELECT COUNT(*) c FROM packs').get().c,
    media: db0.prepare('SELECT COUNT(*) c FROM media').get().c,
    shelves: db0.prepare('SELECT COUNT(*) c FROM shelves').get().c,
  };

  // 1) 数据库快照（含 WAL 里已提交的改动）
  const dbSnap = path.join(stage, '.catalog', 'library.db');
  await fs.mkdir(path.dirname(dbSnap), { recursive: true });
  db0.exec(`VACUUM INTO '${dbSnap.replace(/'/g, "''")}'`);
  db0.close();

  // 校验的是「快照」本身，不是源库
  const snap = new Database(dbSnap, { readonly: true });
  snapDb = snap;
  snapDb = snap;
  const integrity = snap.pragma('integrity_check', { simple: true });
  const snapCounts = {
    characters: snap.prepare('SELECT COUNT(*) c FROM characters').get().c,
    packs: snap.prepare('SELECT COUNT(*) c FROM packs').get().c,
    media: snap.prepare('SELECT COUNT(*) c FROM media').get().c,
    shelves: snap.prepare('SELECT COUNT(*) c FROM shelves').get().c,
  };
  const dbStat = await statSafe(dbSnap);
  if (!dbStat) return fail('数据库快照没写出来');
  if (String(integrity) !== 'ok') return fail(`快照 integrity_check = ${integrity}`);
  for (const k of Object.keys(counts)) {
    if (counts[k] !== snapCounts[k]) return fail(`快照行数对不上：${k} 源 ${counts[k]} / 快照 ${snapCounts[k]}`);
  }
  console.log(`索引库    ${snapCounts.characters} 角色 / ${snapCounts.packs} 图包 / ${snapCounts.media} 媒体 · ${fmtMB(dbStat.size)} · integrity=ok`);

  // 测试钩子：在这之后删 / 加一个媒体，用来验证「备份期间写入」会被发现
  const pauseMs = Number(process.env.CL_BACKUP_PAUSE_AFTER_SNAPSHOT_MS) || 0;
  if (pauseMs > 0) {
    console.log(`[test] 快照已就绪，暂停 ${pauseMs}ms 等外部写入…`);
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  // 2) 复制：顶层目录 + 顶层散落文件（.catalog 单独处理）
  let copiedFiles = 0;
  let copiedBytes = 0;
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  // 稳定顺序：目录在前、文件在后，日志好看
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.catalog') continue;
    const from = path.join(DATA_DIR, entry.name);
    const to = path.join(stage, entry.name);
    try {
      if (entry.isDirectory()) await fs.cp(from, to, { recursive: true });
      else await fs.copyFile(from, to);
    } catch (err) {
      return fail(`复制 ${entry.name} 失败：${err.message}`);
    }
    if (entry.isDirectory()) {
      const list = await listFiles(from);
      const bytes = list.reduce((a, f) => a + f.size, 0);
      copiedFiles += list.length;
      copiedBytes += bytes;
      console.log(`复制      ${entry.name.padEnd(10)} ${String(list.length).padStart(5)} 个文件 / ${fmtMB(bytes)}`);
    } else {
      const st = await statSafe(from);
      copiedFiles += 1;
      copiedBytes += st ? st.size : 0;
      console.log(`复制      ${entry.name}（根目录文件）`);
    }
  }

  // 3) 核对：以快照里的记录为准，逐条确认文件在备份里、大小一致
  const rows = snap.prepare('SELECT id, rel_path, bytes, poster_rel FROM media ORDER BY id').all();
  const missing = [];
  const sizeBad = [];
  for (const r of rows) {
    const p = path.join(stage, ...String(r.rel_path).split('/'));
    const st = await statSafe(p);
    if (!st) {
      missing.push(r.rel_path);
      continue;
    }
    if (r.bytes != null && st.size !== r.bytes) sizeBad.push(`${r.rel_path}（库 ${r.bytes} / 备份 ${st.size}）`);
    if (r.poster_rel) {
      const cover = path.join(stage, ...String(r.poster_rel).split('/'));
      if (!(await statSafe(cover))) missing.push(r.poster_rel);
    }
  }
  if (missing.length || sizeBad.length) {
    const parts = [];
    if (missing.length) parts.push(`${missing.length} 个文件不在备份里（如 ${missing[0]}）`);
    if (sizeBad.length) parts.push(`${sizeBad.length} 个大小不一致（如 ${sizeBad[0]}）`);
    return fail(`快照与备份对不上：${parts.join('；')}`);
  }

  // 4) 抽样比内容哈希（源 vs 备份），抓「大小一样但内容不同」这类静默损坏
  let sampled = 0;
  const mismatch = [];
  if (SAMPLE > 0 && rows.length) {
    const step = Math.max(1, Math.floor(rows.length / SAMPLE));
    for (let i = 0; i < rows.length && sampled < SAMPLE; i += step) {
      const r = rows[i];
      const srcAbs = path.join(DATA_DIR, ...String(r.rel_path).split('/'));
      const bakAbs = path.join(stage, ...String(r.rel_path).split('/'));
      if (!(await statSafe(srcAbs))) continue; // 源在复制后被删，不算备份的错
      const [a, b] = [await sha256(srcAbs), await sha256(bakAbs)];
      sampled += 1;
      if (a !== b) mismatch.push(r.rel_path);
    }
  }
  if (mismatch.length) return fail(`抽样哈希不一致：${mismatch.slice(0, 3).join('、')}`);

  // 5) 条目的目录是否在（缺了只警告：空条目本来就可能没有目录）
  const dirs = snap.prepare("SELECT dir_slug FROM characters WHERE dir_slug IS NOT NULL AND dir_slug <> ''").all();
  const dirMissing = [];
  for (const d of dirs) {
    if (!(await statSafe(path.join(stage, ...String(d.dir_slug).split('/'))))) dirMissing.push(d.dir_slug);
  }

  snap.close();
  snapDb = null;

  // 6) MANIFEST + 恢复说明写在暂存区里，随目录一起改名上线
  const manifest = [
    `备份时间   ${new Date().toLocaleString('zh-CN')}`,
    `源目录     ${DATA_DIR}`,
    `媒体文件   ${copiedFiles} 个（媒体记录 ${rows.length} 条，逐条核对通过）`,
    `媒体字节   ${copiedBytes}`,
    `索引快照   library.db ${dbStat.size} 字节 · integrity=ok · 行数一致`,
    `索引内容   ${snapCounts.shelves} 个库 / ${snapCounts.characters} 角色 / ${snapCounts.packs} 图包 / ${snapCounts.media} 媒体`,
    `抽样校验   ${sampled} 个文件 sha256 一致`,
    dirMissing.length ? `警告       有 ${dirMissing.length} 个条目的目录不在备份里（多为空条目）：${dirMissing.slice(0, 5).join('、')}` : '警告       无',
    `耗时       ${((Date.now() - t0) / 1000).toFixed(1)} 秒`,
    '',
    '恢复方法见同目录 RESTORE.md。',
  ].join('\n');
  await fs.writeFile(path.join(stage, 'MANIFEST.txt'), manifest, 'utf8');
  await fs.writeFile(path.join(stage, 'RESTORE.md'), restoreDoc(), 'utf8');

  // 7) 校验过了才进正式命名空间
  await fs.rename(stage, finalDir);
  finalized = true;
  console.log(
    `\n✓ 校验通过：${rows.length} 条媒体记录全部对得上（${copiedFiles} 个文件 / ${fmtMB(copiedBytes)}），抽样 ${sampled} 个哈希一致`
  );

  // 8) 只清理「名字对 + 有 MANIFEST」的旧备份；本次失败根本走不到这里
  const all = await validBackups();
  for (const old of all.slice(KEEP)) {
    await fs.rm(path.join(DEST_ROOT, old), { recursive: true, force: true });
    console.log(`清理旧备份 ${old}`);
  }
  const left = await validBackups();
  console.log(`当前保留 ${left.length} 份：${left.slice(0, KEEP).join(', ')}`);
  console.log(`恢复说明 ${path.join(finalDir, 'RESTORE.md')}`);
}

function restoreDoc() {
  return `# 恢复步骤

1. **关掉服务**：关掉 start.bat 的窗口，确认 7788 端口没有监听
   （Windows：\`netstat -ano | findstr :7788\`，有输出就先结束那个进程）
2. **先留档，不要直接覆盖**：把现有的 \`${DATA_DIR}\` 整个改名，
   例如 \`${DATA_DIR}-旧-${label}\`
3. **清掉旧的 WAL**：如果目标目录里还有 \`library.db-wal\` / \`library.db-shm\`，先删掉。
   旧 WAL 会被 SQLite 当成新库的日志重放，能把刚恢复的库改坏
4. **拷回**：把本备份目录里的所有内容（含 \`.catalog\\library.db\`、\`.covers\`）拷进目标目录
5. **启动验证**：双击 start.bat，看首页条目数是否和 MANIFEST 一致；
   随便点开几张图、一个视频，确认能打开（缩略图会自动重建，慢一点正常）
6. 确认无误后再删第 2 步的留档目录

## 注意

- 索引是 **${label}** 时刻的快照，媒体文件从同一时刻开始复制；
  之后新入库 / 删除 / 改名 / 移动的内容都不在其中
- \`.covers\` 是视频自定义封面，和媒体一起备份；丢了只会退回自动首帧，不影响素材本身
- 恢复期间不要同时开服务写入，否则恢复出来的库会混进新数据
- 备份目录里如果出现 \`*.failed\`，那是**失败的一次备份**，不能用来恢复（里面有 FAILURE.txt 说明原因）
`;
}

try {
  await main();
} catch (err) {
  if (!finalized) await fail(err && err.message ? err.message : String(err));
  else console.error(err);
} finally {
  // 成功时暂存目录已经改名走人；残留的空 shell 顺手收掉（只碰自己的 .staging）
  await fs.rmdir(stageRoot).catch(() => {});
}
