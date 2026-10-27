/**
 * 清理上传临时区（`<CACHE_DIR>/inbox`）。
 *
 * 上传时 multer 先把文件落到这里，入库（复制到数据盘）成功后应该删掉。
 * 以前少数路径没删干净，一天就堆了 500MB / 582 个文件 —— 这些「源文件」
 * 只该是上传过程中的中转，**库里那份原件绝不能动**。
 *
 * 安全规则（宁可留着，也不误删）：
 *   1. 只处理 INBOX_DIR 里的普通文件，路径前缀校验一次；
 *   2. 先算 sha256，**只有库里存在同 sha 的 media 记录**才继续；
 *   3. 再确认那条记录的 rel_path 在数据盘上真的存在（字节数非 0）；
 *   4. 以上都满足才删临时文件。匹配不上（上传失败 / 库里没有）的一律保留并列出。
 *
 * 用法：
 *   node tools/sweep-inbox.mjs            只统计，不删
 *   node tools/sweep-inbox.mjs --apply    真删（仅删「库里已有同内容」的）
 */
import fs from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, DB_FILE, INBOX_DIR } from '../server/src/config.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

const apply = process.argv.includes('--apply');
const db = new Database(DB_FILE, { readonly: true });

const shaOf = (abs) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(abs)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

const fmt = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

const root = path.resolve(INBOX_DIR);
const rows = db.prepare('SELECT sha256, rel_path FROM media WHERE sha256 IS NOT NULL').all();
const bySha = new Map(rows.map((r) => [r.sha256, r.rel_path]));

let entries = [];
try {
  entries = await fs.readdir(root, { withFileTypes: true });
} catch {
  console.log(`临时区不存在（${root}），不用清理`);
  process.exit(0);
}

let matched = 0;
let matchedBytes = 0;
let kept = 0;
let keptBytes = 0;
let failed = 0;
const keepList = [];

for (const e of entries) {
  if (!e.isFile()) continue;
  const abs = path.resolve(root, e.name);
  // 只碰临时区里的文件，别的一律不认
  if (!abs.startsWith(root + path.sep)) continue;

  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    continue;
  }

  let sha = '';
  try {
    sha = await shaOf(abs);
  } catch (err) {
    kept += 1;
    keptBytes += size;
    keepList.push({ name: e.name, size, reason: `读取失败：${err.code || err.message}` });
    continue;
  }

  const rel = bySha.get(sha);
  const libAbs = rel ? path.join(DATA_DIR, rel) : '';
  const libOk = !!libAbs && existsSync(libAbs) && statSync(libAbs).size > 0;

  if (!libOk) {
    kept += 1;
    keptBytes += size;
    if (keepList.length < 12) {
      keepList.push({ name: e.name, size, reason: rel ? '库里记录在、但文件已缺失' : '库里没有同内容记录' });
    }
    continue;
  }

  matched += 1;
  matchedBytes += size;
  if (!apply) continue;
  try {
    await fs.unlink(abs);
  } catch (err) {
    failed += 1;
    console.error(`删不掉 ${e.name}：${err.code || err.message}`);
  }
}

const total = matched + kept;
console.log(`${apply ? '已清理' : '可清理'}：${matched} 个 / ${fmt(matchedBytes)}（库里已有同一份内容）`);
console.log(`保留：${kept} 个 / ${fmt(keptBytes)}（库里没有或临时区里只有这一份）`);
if (failed) console.log(`删除失败：${failed} 个`);
if (keepList.length) {
  console.log('保留示例：');
  for (const k of keepList) console.log(`  ${k.name}  ${fmt(k.size)}  ${k.reason}`);
}
if (!apply && matched) console.log('加 --apply 才会真删。');
if (!total) console.log('临时区是空的。');
