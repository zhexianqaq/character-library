/**
 * 缩略图吞吐基准：串行 vs 并发，以及 sharp 内部并发度的影响。
 * 用法：node tools/bench-thumb.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const sharp = require('sharp');

const ROOT = process.env.CL_DATA_DIR || 'E:\\CharacterLibrary';
const db = new Database(path.join(ROOT, '.catalog/library.db'), { readonly: true });

const rows = db
  .prepare(`SELECT id, rel_path, kind FROM media WHERE kind='image' ORDER BY id LIMIT 24`)
  .all();

const src = (r) => path.join(ROOT, ...r.rel_path.split('/'));
const OUT = path.join(ROOT, '.catalog', 'bench');
await fs.mkdir(OUT, { recursive: true });

async function one(i) {
  const r = rows[i % rows.length];
  const buf = await sharp(src(r), { failOn: 'none' })
    .rotate()
    .resize({ width: 420, withoutEnlargement: true })
    .webp({ quality: 74, effort: 2 })
    .toBuffer();
  return buf.length;
}

function pool(tasks, limit) {
  return new Promise((resolve, reject) => {
    let running = 0;
    let idx = 0;
    let done = 0;
    let bytes = 0;
    const next = () => {
      while (running < limit && idx < tasks.length) {
        const i = idx++;
        running += 1;
        tasks[i]()
          .then((n) => {
            bytes += n;
          })
          .catch(reject)
          .finally(() => {
            running -= 1;
            done += 1;
            if (done === tasks.length) resolve(bytes);
            else next();
          });
      }
    };
    next();
  });
}

async function bench(label, concurrency, internal) {
  sharp.concurrency(internal);
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const tasks = rows.map((_, i) => () => one(i));
  const t0 = Date.now();
  const bytes = await pool(tasks, concurrency);
  const ms = Date.now() - t0;
  console.log(
    `${label.padEnd(26)} 并发=${String(concurrency).padStart(2)}  libvips线程=${String(internal).padStart(2)}  ` +
      `${String(ms).padStart(5)}ms  ${(rows.length / (ms / 1000)).toFixed(1)} 张/秒  ${Math.round(bytes / 1024)}KB`
  );
  return ms;
}

console.log(`样本：${rows.length} 张真实图片（420px WebP q74）\n`);
await bench('串行', 1, 1);
await bench('并发8 · 内部默认', 8, 16);
await bench('并发8 · 内部1线程', 8, 1);
await bench('并发8 · 内部2线程', 8, 2);
await bench('并发16 · 内部1线程', 16, 1);
await bench('并发4 · 内部4线程', 4, 4);
console.log('');
