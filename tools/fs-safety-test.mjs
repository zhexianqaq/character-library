/**
 * 文件操作 / 删除 / 备份 的隔离测试。
 *
 * 全程只用临时目录（os.tmpdir()/cl-fs-test-<ts>/{data,cache,backup}），
 * 通过环境变量把服务指过去，**绝不碰 E:\CharacterLibrary**。
 *
 * 用法：node tools/fs-safety-test.mjs
 *
 * 覆盖：
 *   1. Windows 命名清洗（保留设备名 / 结尾点空格 / 长名截断保扩展名）
 *   2. 跨角色移动：正常、目标已有同名不同内容、数据库写入失败回滚
 *   3. 删除失败：单条 409、批量部分成功
 *   4. 备份：正常备份 + 恢复演练；备份期间文件消失必须失败且不动旧备份；
 *      数据根目录散落文件也要进备份
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lockFileExclusive, waitLocked } from './lock-helper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

const TMP = path.join(os.tmpdir(), `cl-fs-test-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const CACHE = path.join(TMP, 'cache');
const BACKUP = path.join(TMP, 'backup');
const PORT = 7900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, status: ok ? 'pass' : 'fail', detail });
  console.log(`  ${ok ? '✓' : '✗'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const skip = (name, detail = '') => {
  results.push({ name, status: 'skip', detail });
  console.log(`  ⊘  ${name}${detail ? `  —  ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const relToAbs = (rel) => path.join(DATA, ...String(rel).split('/'));

/** 直连临时库读 rel_path（API 不暴露这个字段） */
let dbConn = null;
function getRel(id) {
  if (!dbConn) {
    dbConn = new Database(path.join(DATA, '.catalog', 'library.db'), { readonly: true });
    dbConn.pragma('busy_timeout = 5000');
  }
  return dbConn.prepare('SELECT rel_path FROM media WHERE id = ?').get(id)?.rel_path || '';
}

let server = null;
const serverLog = [];

async function jfetch(url, opts) {
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
const jpost = (u, b) => jfetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
const jpatch = (u, b) => jfetch(u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
const jdel = (u) => jfetch(u, { method: 'DELETE' });

/** 用 sharp（server 里已有）生成带一点噪声的 PNG，避免同色被去重 */
async function genImage(label, size = 320) {
  const sharp = require('sharp');
  const w = size;
  const h = Math.round(size * 0.75);
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${w}" height="${h}"><text x="20" y="${Math.round(h / 2)}" font-size="34" fill="#fff">${label}</text></svg>`
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  return buf;
}

async function upload(charId, packId, name, buf) {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/png' }), name);
  if (packId) fd.append('packId', String(packId));
  const res = await fetch(`${BASE}/api/characters/${charId}/media`, { method: 'POST', body: fd });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function waitServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/overview`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  return false;
}

function startServer() {
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      CL_DATA_DIR: DATA,
      CL_CACHE_DIR: CACHE,
      PORT: String(PORT),
      CL_BACKUP_PAUSE_AFTER_SNAPSHOT_MS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));
}

async function stopServer() {
  if (!server) return;
  server.kill();
  await sleep(300);
  server = null;
}

function runBackup(extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'backup.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CL_DATA_DIR: DATA,
        CL_CACHE_DIR: CACHE,
        CL_BACKUP_DIR: BACKUP,
        CL_BACKUP_SAMPLE: '6',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** 只删本次测试的临时目录（先确认路径） */
async function cleanup() {
  const okPrefix = path.resolve(TMP).startsWith(path.resolve(os.tmpdir()) + path.sep) && /cl-fs-test-\d+$/.test(TMP);
  if (!okPrefix) {
    console.error(`拒绝清理：${TMP} 不像本次测试的临时目录`);
    return false;
  }
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function main() {
  await fsp.mkdir(DATA, { recursive: true });
  await fsp.mkdir(CACHE, { recursive: true });
  await fsp.mkdir(BACKUP, { recursive: true });
  console.log(`临时根目录 ${TMP}\n`);

  // 1) 纯函数：Windows 命名规则
  process.env.CL_DATA_DIR = DATA;
  process.env.CL_CACHE_DIR = CACHE;
  const { slugify, cleanSegment } = await import('../server/src/config.js');
  const { safeFileName } = await import('../server/src/store.js');
  check('保留设备名加前缀（CON → _CON）', slugify('CON') === '_CON', slugify('CON'));
  check('设备名带扩展名也要处理（CON.mp4）', cleanSegment('CON.mp4').startsWith('_'), cleanSegment('CON.mp4'));
  check('去掉结尾的点（"a." → "a"）', slugify('a.') === 'a', JSON.stringify(slugify('a.')));
  check('去掉结尾空格', slugify('名字   ') === '名字', JSON.stringify(slugify('名字   ')));
  check('空名兜底', slugify('   ') === 'unnamed', slugify('   '));
  const longName = `${'长'.repeat(120)}.mp4`;
  const safe = safeFileName(longName);
  check('超长文件名截断时保留扩展名', safe.length <= 100 && safe.endsWith('.mp4'), `${safe.length} 字：…${safe.slice(-8)}`);
  check('文件名也不落在设备名上', safeFileName('NUL.png').startsWith('_'), safeFileName('NUL.png'));

  // 2) 起服务（只用临时目录）
  startServer();
  if (!(await waitServer())) throw new Error('服务没起来：\n' + serverLog.join('').slice(-800));
  const ov = await jfetch('/api/overview');
  const shelf = ov.body.shelves[0];
  check('服务跑在临时数据目录上', fs.existsSync(path.join(DATA, '.catalog', 'library.db')), DATA);

  const mkChar = async (name) => (await jpost('/api/characters', { shelfId: shelf.id, name })).body;
  const A = await mkChar('测试甲');
  const B = await mkChar('测试乙');
  const pA = (await jpost(`/api/characters/${A.id}/packs`, { title: '甲包' })).body;
  const pB = (await jpost(`/api/characters/${B.id}/packs`, { title: '乙包' })).body;

  // 3) 跨角色移动：正常
  const buf1 = await genImage('one');
  const up1 = await upload(A.id, pA.id, 'one.png', buf1);
  const id1 = up1.body.ids[0];
  const srcRel1 = getRel(id1);
  const mv1 = await jpost(`/api/packs/${pB.id}/media`, { ids: [id1] });
  const dstRel1 = getRel(id1);
  check(
    '跨角色移动：记录指到新目录，文件真的搬过去了',
    mv1.status === 200 && mv1.body.moved === 1 && !fs.existsSync(relToAbs(srcRel1)) && fs.existsSync(relToAbs(dstRel1)),
    `${srcRel1} → ${dstRel1}`
  );
  const journalLeft1 = fs.existsSync(path.join(DATA, '.catalog', 'pending-moves'))
    ? fs.readdirSync(path.join(DATA, '.catalog', 'pending-moves')).length
    : 0;
  check('移动成功后不留 pending 记录', journalLeft1 === 0, `剩 ${journalLeft1} 条`);

  // 4) 跨角色移动：目标已有同名但内容不同 → 不能删源
  const buf2 = await genImage('two');
  const up2 = await upload(A.id, pA.id, 'two.png', buf2);
  const id2 = up2.body.ids[0];
  const srcRel2 = getRel(id2);
  const base2 = path.basename(srcRel2);
  const dstDirRel2 = path.dirname(dstRel1).split(path.sep).join('/'); // 乙包的图片目录
  const decoy = Buffer.from('这不是同一份内容，只是占了同名位置');
  fs.writeFileSync(relToAbs(`${dstDirRel2}/${base2}`), decoy);
  const mv2 = await jpost(`/api/packs/${pB.id}/media`, { ids: [id2] });
  const dstRel2 = getRel(id2);
  const movedContent = fs.existsSync(relToAbs(dstRel2)) ? fs.readFileSync(relToAbs(dstRel2)) : Buffer.alloc(0);
  check(
    '目标同名不同内容：改存新名，源内容完整保留',
    mv2.status === 200 && sha(movedContent) === sha(buf2) && dstRel2 !== `${dstDirRel2}/${base2}` && !fs.existsSync(relToAbs(srcRel2)),
    `${dstRel2.split('/').pop()} · ${mv2.body.warnings?.length || 0} 条提示`
  );

  // 5) 数据库写入失败 → 文件必须搬回
  const buf3 = await genImage('three');
  const up3 = await upload(A.id, pA.id, 'three.png', buf3);
  const id3 = up3.body.ids[0];
  const srcRel3 = getRel(id3);
  const db = new Database(path.join(DATA, '.catalog', 'library.db'));
  db.pragma('busy_timeout = 8000');
  db.exec("CREATE TRIGGER t_block_media BEFORE UPDATE ON media BEGIN SELECT RAISE(ABORT,'injected-db-failure'); END");
  let mv3;
  try {
    mv3 = await jpost(`/api/packs/${pB.id}/media`, { ids: [id3] });
  } finally {
    db.exec('DROP TRIGGER t_block_media');
    db.close();
  }
  const rel3After = getRel(id3);
  const pend = fs.existsSync(path.join(DATA, '.catalog', 'pending-moves'))
    ? fs.readdirSync(path.join(DATA, '.catalog', 'pending-moves'))
    : [];
  check(
    '数据库写入失败：文件搬回原处、记录不变',
    mv3.status === 200 &&
      mv3.body.moved === 0 &&
      rel3After === srcRel3 &&
      fs.existsSync(relToAbs(srcRel3)) &&
      /数据库写入失败/.test(mv3.body.skipped[0]?.reason || ''),
    `${mv3.body.skipped?.[0]?.reason || ''}`
  );
  check('回滚后 pending 记录清空', pend.length === 0, `剩 ${pend.length} 条`);

  await checkArchiveSource(mkChar);

  // 6) 删除失败：另一个进程独占打开文件（等同播放器正在播），必须返回 409 且记录还在
  const buf4 = await genImage('four');
  const up4 = await upload(A.id, pA.id, 'four.png', buf4);
  const id4 = up4.body.ids[0];
  const abs4 = relToAbs(getRel(id4));
  const lock4 = lockFileExclusive(abs4, 25);
  const lock4on = await waitLocked(abs4);
  const del1 = await jdel(`/api/media/${id4}`);
  const stillRow = (await jfetch(`/api/media/${id4}`)).status;
  check(
    '文件被占用：返回 409、记录和文件都还在',
    lock4on && del1.status === 409 && stillRow === 200 && fs.existsSync(abs4),
    lock4on ? `HTTP ${del1.status} · ${del1.body?.error || ''}` : '占用没生效（PowerShell 未起来）'
  );
  lock4.kill();
  await sleep(700);
  const del2 = await jdel(`/api/media/${id4}`);
  check('解除占用后能正常删掉', del2.status === 200 && !fs.existsSync(abs4), `HTTP ${del2.status}`);

  // 7) 批量部分成功：3 个里 1 个被占用
  const bufs = [await genImage('b1'), await genImage('b2'), await genImage('b3')];
  const ids = [];
  for (let i = 0; i < bufs.length; i += 1) {
    const r = await upload(A.id, pA.id, `bulk${i}.png`, bufs[i]);
    ids.push(r.body.ids[0]);
  }
  const abs5 = relToAbs(getRel(ids[1]));
  const lock5 = lockFileExclusive(abs5, 25);
  await waitLocked(abs5);
  const bulkBody = (await jpost('/api/media/bulk', { ids, action: 'delete' })).body;
  const survivor = await jfetch(`/api/media/${ids[1]}`);
  lock5.kill();
  await sleep(700);
  check(
    '批量删除部分失败：如实报告 done / failed',
    bulkBody.done === 2 && (bulkBody.failed || []).length === 1,
    `done=${bulkBody.done} failed=${(bulkBody.failed || []).length} · ${bulkBody.failed?.[0]?.reason || ''}`
  );
  check('失败的那一条记录被保留（还能重试）', survivor.status === 200, `HTTP ${survivor.status}`);
  await jdel(`/api/media/${ids[1]}`); // 清掉，别影响备份计数

  // 7.5) 删条目时目录删不掉：整次删除失败，条目还在（不会留下没人认领的文件）
  //      注：本机（沙箱内）fs.rm 会被重定向到回收站，"文件被占用"这种场景复现不出来，
  //      这里用「目录路径非法」把失败分支走到（removeDir 返回 EINVAL）
  const C = await mkChar('测试丙');
  const pC = (await jpost(`/api/characters/${C.id}/packs`, { title: '丙包' })).body;
  const upC = await upload(C.id, pC.id, 'c1.png', await genImage('c1'));
  const realDir = path.dirname(path.dirname(path.dirname(getRel(upC.body.ids[0]))));
  const wdb = new Database(path.join(DATA, '.catalog', 'library.db'));
  wdb.pragma('busy_timeout = 8000');
  wdb.prepare('UPDATE characters SET dir_slug = ? WHERE id = ?').run('../逃出去的目录', C.id);
  wdb.close();
  const delC1 = await jdel(`/api/characters/${C.id}`);
  const stillC = await jfetch(`/api/characters/${C.id}`);
  check(
    '删条目时目录删不掉：返回 409，条目和文件都留着',
    delC1.status === 409 && stillC.status === 200 && fs.existsSync(relToAbs(realDir)),
    `HTTP ${delC1.status} · ${delC1.body?.error || ''}`
  );
  const wdb2 = new Database(path.join(DATA, '.catalog', 'library.db'));
  wdb2.prepare('UPDATE characters SET dir_slug = ? WHERE id = ?').run(realDir, C.id);
  wdb2.close();
  const delC2 = await jdel(`/api/characters/${C.id}`);
  check(
    '恢复合法路径后条目能删干净（目录一起消失）',
    delC2.status === 200 && (await jfetch(`/api/characters/${C.id}`)).status === 404 && !fs.existsSync(relToAbs(realDir)),
    `HTTP ${delC2.status}`
  );

  // 8) 备份：正常 + 恢复演练
  await fsp.writeFile(path.join(DATA, 'root-note.txt'), '根目录散落文件也必须进备份', 'utf8');
  const bk1 = await runBackup();
  const backups1 = fs.readdirSync(BACKUP).filter((n) => /^\d{8}-\d{6}$/.test(n));
  const target1 = path.join(BACKUP, backups1[0] || 'missing');
  check('备份成功（退出码 0）', bk1.code === 0, (bk1.out.match(/✓[^\n]*/) || [''])[0]);
  check('生成了正式备份目录 + MANIFEST', backups1.length === 1 && fs.existsSync(path.join(target1, 'MANIFEST.txt')), backups1[0] || '无');
  check('根目录散落文件也进备份了', fs.existsSync(path.join(target1, 'root-note.txt')));
  check('恢复说明写进备份目录', fs.existsSync(path.join(target1, 'RESTORE.md')));

  // 恢复演练：拷到全新目录，核对「每条记录都有对应文件」
  const restore = path.join(TMP, 'restore');
  await fsp.cp(target1, restore, { recursive: true });
  const rdb = new Database(path.join(restore, '.catalog', 'library.db'), { readonly: true });
  const rows = rdb.prepare('SELECT id, rel_path, bytes FROM media').all();
  let missing = 0;
  let sizeBad = 0;
  for (const r of rows) {
    const p = path.join(restore, ...String(r.rel_path).split('/'));
    const st = fs.existsSync(p) ? fs.statSync(p) : null;
    if (!st) missing += 1;
    else if (r.bytes != null && st.size !== r.bytes) sizeBad += 1;
  }
  const integrity = rdb.pragma('integrity_check', { simple: true });
  rdb.close();
  check(
    '恢复出来的库：记录与文件一一对应',
    rows.length > 0 && missing === 0 && sizeBad === 0 && integrity === 'ok',
    `${rows.length} 条记录 · 缺 ${missing} · 大小不符 ${sizeBad} · integrity=${integrity}`
  );
  const sampleRel = rows[0]?.rel_path;
  let readable = false;
  if (sampleRel) {
    try {
      const sharp = require('sharp');
      const meta = await sharp(path.join(restore, ...String(sampleRel).split('/'))).metadata();
      readable = !!meta.width;
    } catch {
      readable = false;
    }
  }
  check('恢复出来的图片能正常解码', readable, sampleRel || '');

  // 9) 备份期间文件消失 → 必须失败，不动旧备份
  const before = fs.readdirSync(BACKUP).filter((n) => /^\d{8}-\d{6}$/.test(n));
  const victim = rows[0];
  const victimAbs = relToAbs(victim?.rel_path || '');
  const victimBytes = victimAbs && fs.existsSync(victimAbs) ? fs.readFileSync(victimAbs) : null;
  const bkPromise = runBackup({ CL_BACKUP_PAUSE_AFTER_SNAPSHOT_MS: '2500' });
  await sleep(1200); // 等它做完快照、进入暂停
  try {
    if (victimAbs && fs.existsSync(victimAbs)) fs.unlinkSync(victimAbs);
  } catch {
    /* 忽略 */
  }
  const bk2 = await bkPromise;
  const after = fs.readdirSync(BACKUP).filter((n) => /^\d{8}-\d{6}$/.test(n));
  const failedDirs = fs.readdirSync(BACKUP).filter((n) => n.endsWith('.failed'));
  check('备份期间文件消失：退出码非 0，报失败不报成功', bk2.code !== 0 && /备份失败/.test(bk2.out), (bk2.out.match(/✗[^\n]*/) || [''])[0]);
  check('失败现场单独标记（.failed + FAILURE.txt）', failedDirs.length === 1 && fs.existsSync(path.join(BACKUP, failedDirs[0], 'FAILURE.txt')), failedDirs[0] || '无');
  check('失败不会新增「正式备份」', after.length === before.length, `${before.length} → ${after.length}`);
  check('旧备份没有被清掉', before.every((n) => fs.existsSync(path.join(BACKUP, n))), before.join(','));

  // 10) 补回被删的文件，再跑一次备份确认能恢复正常
  if (victimAbs) {
    await fsp.mkdir(path.dirname(victimAbs), { recursive: true });
    fs.writeFileSync(victimAbs, victimBytes || (await genImage('restored')));
  }
  const bk3 = await runBackup();
  check('补回文件后备份恢复正常', bk3.code === 0, (bk3.out.match(/✓[^\n]*/) || [''])[0]);

  // 11) 保留策略：只清「正式备份」，.failed 不算一份、也不会被当成清理对象
  const bk4 = await runBackup({ CL_BACKUP_KEEP: '1' });
  const validNow = fs.readdirSync(BACKUP).filter((n) => /^\d{8}-\d{6}(-\d+)?$/.test(n));
  const failedNow = fs.readdirSync(BACKUP).filter((n) => n.endsWith('.failed'));
  check(
    '保留策略只留最新一份，失败的目录原地不动',
    bk4.code === 0 && validNow.length === 1 && failedNow.length === (failedDirs.length || failedNow.length),
    `正式 ${validNow.length} 份 · 失败目录 ${failedNow.length} 个`
  );

  // 压缩包用例在 checkArchiveSource，放在文件锁测试之前（那一步依赖 Windows 的 powershell）
}

async function checkArchiveSource(mkChar) {
  const archChar = await mkChar('压缩包甲');
  const zipDir = path.join(TMP, 'zips');
  await fsp.mkdir(zipDir, { recursive: true });
  const pngA = await genImage('zip-a');
  const pngB = await genImage('zip-b');
  const pngC = await genImage('zip-c');
  const pngD = await genImage('zip-d');

  const partialPath = path.join(zipDir, 'partial.zip');
  fs.writeFileSync(
    partialPath,
    buildStoredZip([
      { name: 'ok.png', data: pngA },
      { name: 'bad.png', data: pngB, crc: (zlib.crc32(pngB) ^ 0xffffffff) >>> 0 },
    ])
  );
  const partial = await jpost('/api/import/paths', { paths: [partialPath], charId: archChar.id, move: true });
  const partialFails = partial.body && partial.body.failures;
  check(
    '部分解压失败：源压缩包留在原地，并列出失败文件',
    partial.status === 200 &&
      fs.existsSync(partialPath) &&
      (partial.body.removed || []).length === 0 &&
      (partial.body.kept || []).includes(partialPath) &&
      Array.isArray(partialFails) &&
      partialFails.some((f) => f.name === 'bad.png'),
    `HTTP ${partial.status} · ${(partialFails || []).map((f) => f.name + ':' + f.reason).join('; ')}`
  );

  const okPath = path.join(zipDir, 'both.zip');
  const okBytes = buildStoredZip([
    { name: 'one.png', data: pngC },
    { name: 'two.png', data: pngD },
  ]);
  fs.writeFileSync(okPath, okBytes);
  const okRes = await jpost('/api/import/paths', { paths: [okPath], charId: archChar.id, move: true });
  check(
    '全部入库：源压缩包被删',
    okRes.status === 200 && okRes.body.added === 2 && !fs.existsSync(okPath) && (okRes.body.failures || []).length === 0,
    `added=${okRes.body && okRes.body.added} 还在=${fs.existsSync(okPath)}`
  );

  fs.writeFileSync(okPath, okBytes);
  const dupRes = await jpost('/api/import/paths', { paths: [okPath], charId: archChar.id, move: true });
  const dupReasons = ((dupRes.body && dupRes.body.skipped) || []).map((s) => s.reason);
  check(
    '全部是已核对的重复：源压缩包被删',
    dupRes.status === 200 &&
      dupRes.body.added === 0 &&
      !fs.existsSync(okPath) &&
      dupReasons.length === 2 &&
      dupReasons.every((r) => r === '重复文件'),
    `added=${dupRes.body && dupRes.body.added} · ${dupReasons.join(',')}`
  );

  const fd = new FormData();
  fd.append('archive', new Blob([fs.readFileSync(partialPath)]), 'partial-upload.zip');
  const upRes = await fetch(`${BASE}/api/characters/${archChar.id}/archive`, { method: 'POST', body: fd });
  const upBody = await upRes.json().catch(() => null);
  check(
    '网页上传部分失败：保留服务器上的压缩包，并列出失败文件',
    upRes.status === 200 &&
      upBody &&
      upBody.sourceKept === true &&
      upBody.keptArchive &&
      fs.existsSync(upBody.keptArchive) &&
      (upBody.failures || []).some((f) => f.name === 'bad.png'),
    `HTTP ${upRes.status} · ${upBody && upBody.keptArchive}`
  );

  const lockPath = path.join(zipDir, 'lock.zip');
  fs.writeFileSync(lockPath, buildStoredZip([{ name: 'lock.png', data: pngA, flags: 1 }]));
  const lockRes = await jpost('/api/import/paths', { paths: [lockPath], charId: archChar.id, move: true });
  check(
    '需要密码：不删源压缩包',
    lockRes.status === 400 && lockRes.body.code === 'NEED_PASSWORD' && fs.existsSync(lockPath),
    lockRes.body && (lockRes.body.code || lockRes.body.error)
  );
}

/** 测试用的未压缩 zip。crc / flags 用来造「校验失败」和「有密码」。 */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = (e.crc != null ? e.crc : zlib.crc32(data)) >>> 0;
    const flags = e.flags || 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const blob = Buffer.concat([local, data]);
    locals.push(blob);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += blob.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

try {
  await main();
} catch (err) {
  check('测试执行中断', false, String(err && err.message ? err.message : err));
} finally {
  await stopServer();
  const keep = process.env.CL_FS_TEST_KEEP === '1';
  const cleaned = keep ? false : await cleanup();
  console.log(`\n临时目录${cleaned ? '已清理' : '保留待查'}：${TMP}`);
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过（共 ${results.length} 项）\n`);
  process.exitCode = fail ? 1 : 0;
}
