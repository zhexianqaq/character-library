/**
 * 回填 media.anim：按真实帧数判断动图，而不是看扩展名。
 * 只扫 .gif / .webp / .png（其余格式不可能多帧）。
 *
 * 用法（在 server 目录下）：node src/backfill-anim.mjs
 */
import path from 'node:path';
import sharp from 'sharp';
import { getDb } from './db.js';
import { absPathOf } from './store.js';

const db = getDb();
const rows = db
  .prepare(
    `SELECT id, rel_path, ext FROM media
     WHERE kind = 'image' AND LOWER(ext) IN ('.gif', '.webp', '.png', '.apng')`
  )
  .all();

const upd = db.prepare('UPDATE media SET anim = ? WHERE id = ?');
console.log(`需要检查 ${rows.length} 张（gif / webp / png）`);

let anim = 0;
let still = 0;
let fail = 0;
let i = 0;
for (const r of rows) {
  i += 1;
  try {
    const m = await sharp(absPathOf(r.rel_path), { failOn: 'none' }).metadata();
    const on = (m.pages || 1) > 1 ? 1 : 0;
    upd.run(on, r.id);
    if (on) anim += 1;
    else still += 1;
  } catch {
    upd.run(0, r.id);
    fail += 1;
  }
  if (i % 100 === 0) process.stdout.write(`\r  ${i}/${rows.length}  动图 ${anim}  静态 ${still}   `);
}
// 视频一律算动图
db.prepare("UPDATE media SET anim = 1 WHERE kind = 'video'").run();
// 其余格式肯定是静态
db.prepare("UPDATE media SET anim = 0 WHERE kind = 'image' AND LOWER(ext) NOT IN ('.gif', '.webp', '.png', '.apng')").run();

console.log(`\n完成：动图 ${anim}，静态 ${still}，读取失败 ${fail}`);
process.exit(0);
