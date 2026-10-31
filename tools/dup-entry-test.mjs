/**
 * 同库同名：别名不算，别的库可以同名。
 * 已有重复不会被迁移删掉。
 *
 *   node tools/dup-entry-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { entryNameKey } from '../server/src/entry-name.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

const TMP = path.join(os.tmpdir(), `cl-dup-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const CACHE = path.join(TMP, 'cache');
const PORT = 7400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`  ${ok ? '✓' : '✗'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const jpost = (u, b) =>
  jfetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}),
  });

function startServer() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, CL_DATA_DIR: DATA, CL_CACHE_DIR: CACHE, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/overview`)).ok) return true;
    } catch {
      /* */
    }
    await sleep(100);
  }
  return false;
}

function stop(child) {
  child.kill();
  return new Promise((resolve) => child.on('close', resolve));
}

async function main() {
  check('全角和大小写折成同一个 key', entryNameKey(' Ａqua ') === entryNameKey('aqua') && entryNameKey('水  淼') === '水 淼');
  check('别名不进 key 函数（函数只处理一个名字）', entryNameKey('乙') !== entryNameKey('甲'));

  await fsp.mkdir(DATA, { recursive: true });
  let child = startServer();
  if (!(await waitServer())) {
    check('服务起来', false);
    await stop(child);
    return;
  }

  const ov = await jfetch('/api/overview');
  const shelfA = ov.body.shelves[0].id;
  const shelfB = (await jpost('/api/shelves', { name: '另一个库', kind: 'people' })).body.id;

  const a = await jpost('/api/characters', { shelfId: shelfA, name: ' 水  淼 ' });
  const again = await jpost('/api/characters', { shelfId: shelfA, name: '水 淼' });
  check(
    '同库同名（空白差异）被拦下，并带回已有条目',
    a.status === 200 && again.status === 409 && again.body.code === 'DUPLICATE_ENTRY' && again.body.id === a.body.id,
    `HTTP ${again.status}`
  );
  const other = await jpost('/api/characters', { shelfId: shelfB, name: '水 淼' });
  check('另一个库可以同名', other.status === 200 && other.body.id !== a.body.id);

  const aqua = await jpost('/api/characters', { shelfId: shelfA, name: 'Aqua' });
  const folded = await jpost('/api/characters', { shelfId: shelfA, name: 'ＡQUA' });
  check(
    '全角和大小写算重名',
    aqua.status === 200 && folded.status === 409 && folded.body.id === aqua.body.id,
    folded.body && folded.body.error
  );

  const jia = await jpost('/api/characters', { shelfId: shelfA, name: '甲', aliases: ['乙'] });
  const bioAlias = await jpost('/api/characters/bulk-bio', {
    shelfId: shelfA,
    dryRun: false,
    items: [{ name: '乙', intro: '不该写到甲' }],
  });
  const bioName = await jpost('/api/characters/bulk-bio', {
    shelfId: shelfA,
    dryRun: false,
    items: [{ name: '甲', intro: '甲的简介' }],
  });
  const jiaRow = await jfetch(`/api/characters/${jia.body.id}`);
  check(
    '简介导入不把别名当成条目名',
    bioAlias.body.matched === 0 && bioName.body.matched === 1 && jiaRow.body.intro === '甲的简介',
    `alias matched=${bioAlias.body.matched} intro=${jiaRow.body.intro}`
  );

  const renamed = await jpost('/api/characters', { shelfId: shelfA, name: '丙' });
  const clash = await jfetch(`/api/characters/${renamed.body.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'aqua' }),
  });
  check('改成同库已有的名字会被拦下', clash.status === 409 && clash.body.id === aqua.body.id, clash.body && clash.body.error);

  // 历史重复：拆掉唯一索引，塞进第二条，再启动。两条都还在，第三条建不了。
  await stop(child);
  const db = new Database(path.join(DATA, '.catalog', 'library.db'));
  db.pragma('busy_timeout = 5000');
  db.exec('DROP INDEX IF EXISTS uniq_char_shelf_name');
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(a.body.id);
  db.prepare(
    `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, name_key, name_legacy_dup, sort_order, created_at, updated_at, is_container)
     VALUES(?,?,?,?,?,?,0,0,?, ?, 0)`
  ).run(row.shelf_id, row.name, '', '', `${row.dir_slug}-legacy`, row.name_key, row.created_at, row.updated_at);
  db.close();

  child = startServer();
  if (!(await waitServer())) {
    check('带着历史重名重新启动', false);
    return;
  }
  const report = await jfetch('/api/duplicate-entries');
  const listed = (report.body.groups || []).some((g) => (g.entries || []).length >= 2);
  const still = await jfetch(`/api/characters/${a.body.id}`);
  const third = await jpost('/api/characters', { shelfId: shelfA, name: '水 淼' });
  const countDb = new Database(path.join(DATA, '.catalog', 'library.db'), { readonly: true });
  const count = countDb
    .prepare('SELECT COUNT(*) n FROM characters WHERE shelf_id = ? AND name_key = ? AND is_container = 0')
    .get(shelfA, entryNameKey('水 淼'));
  countDb.close();
  const group = (report.body.groups || []).find((g) => g.nameKey === entryNameKey('水 淼'));
  check(
    '历史重名还在，并写进清单；不能再新建第三条',
    listed && (group && group.entries.length >= 2) && still.status === 200 && third.status === 409 && count.n === 2,
    `entries=${group && group.entries.length} count=${count.n} HTTP ${third.status}`
  );

  const src = path.join(TMP, '导入甲');
  await fsp.mkdir(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.png'), PNG);
  await jpost('/api/characters', { shelfId: shelfA, name: '导入甲' });
  const cli = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['src/import-cli.js', src, '--name', '导入甲', '--move'], {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, CL_DATA_DIR: DATA, CL_CACHE_DIR: CACHE },
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });
  check(
    '命令行导入碰到同名就不新建，也不删源文件',
    cli.code === 1 && fs.existsSync(path.join(src, 'a.png')) && /已经有/.test(cli.out),
    `code=${cli.code}`
  );

  await stop(child);
}

try {
  await main();
} catch (err) {
  check('测试执行中断', false, String(err && err.message ? err.message : err));
} finally {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${results.length - fail} 通过 / ${fail} 失败\n`);
  process.exitCode = fail ? 1 : 0;
}
