/**
 * 库改名：一次把「显示名 + 磁盘目录 + dir_slug + rel_path」四件套改到位。
 *
 * 为什么要四件套一起改：库名参与三处持久化 ——
 *   - `shelves.name`：界面显示
 *   - `characters.dir_slug`：条目目录（形如 `人物库/水淼`）
 *   - `media.rel_path`：文件相对路径（形如 `人物库/水淼/杂项/图片/a.jpg`）
 * 只改第一处，新建的条目会落到新名字的目录，磁盘就裂成两套。
 *
 * 安全措施：
 *   - 默认 dry-run，加 `--apply` 才真改
 *   - 先把 DB 快照复制成 `library.db.before-rename`（调用方负责，脚本会检查存在）
 *   - 目录 rename 先做；DB 更新在事务里，失败则把目录 rename 回来
 *   - 幂等：旧名字查不到就跳过（已经改过）
 *
 * 用法：
 *   node tools/rename-shelves.mjs --dry-run
 *   node tools/rename-shelves.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DB_FILE, DATA_DIR } from '../server/src/config.js';

// 依赖装在 server/ 下，从 tools/ 直接 import 解析不到（与 backup.mjs 同款写法）
const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

/** 旧名 → 新名。kind/variant 用来保证改的是同一个库，名字撞车时不误伤。 */
const RENAMES = [
  { from: '人物库', to: '人物集', kind: 'people' },
  { from: '角色库', to: '角色集', kind: 'work' },
  { from: '表情库', to: '表情包', kind: 'emoji' },
  { from: '资源库', to: '作品录', kind: 'resource' },
  { from: '原创库', to: '原创书', kind: 'novel', variant: 'original' },
  { from: '同人库', to: '同人书', kind: 'novel', variant: 'fanfic' },
  { from: '全部库', to: '收件箱', kind: 'inbox' },
  { from: '散图库', to: '散图集', kind: 'loose' },
];

const apply = process.argv.includes('--apply');
const now = new Date().toISOString();
const db = new Database(DB_FILE);

console.log(`DB     : ${DB_FILE}`);
console.log(`DATA   : ${DATA_DIR}`);
console.log(`mode   : ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

if (apply && !fs.existsSync(`${DB_FILE}.before-rename`)) {
  console.error('[x] 没有找到数据库快照 library.db.before-rename，先备份再改：');
  console.error('    cp "<DATA>/.catalog/library.db" "<DATA>/.catalog/library.db.before-rename"');
  process.exit(1);
}

/** 一个库的完整迁移；失败时把目录 rename 回来。 */
function migrate({ from, to, kind, variant }) {
  const shelf = db.prepare('SELECT id, name, kind, variant FROM shelves WHERE name = ?').get(from);
  if (!shelf) {
    console.log(`- ${from}: 不存在（可能已改名），跳过`);
    return { skipped: true };
  }
  if (kind && shelf.kind !== kind) {
    throw new Error(`${from} 的 kind 是 ${shelf.kind}，期望 ${kind}，拒绝改`);
  }
  if (variant && shelf.variant !== variant) {
    throw new Error(`${from} 的 variant 是 ${shelf.variant}，期望 ${variant}，拒绝改`);
  }

  const fromDir = path.join(DATA_DIR, from);
  const toDir = path.join(DATA_DIR, to);
  const hasFrom = fs.existsSync(fromDir);
  const hasTo = fs.existsSync(toDir);

  const chars = db
    .prepare('SELECT COUNT(*) c FROM characters WHERE dir_slug = ? OR dir_slug LIKE ?')
    .get(from, `${from}/%`).c;
  const media = db.prepare('SELECT COUNT(*) c FROM media WHERE rel_path LIKE ?').get(`${from}/%`).c;

  console.log(`- ${from} → ${to}  (shelf#${shelf.id}, 条目 ${chars}, 媒体 ${media})`);
  console.log(`    目录: ${hasFrom ? '存在' : '缺失'} → ${hasTo ? '目标已存在（冲突）' : '可创建'}`);

  if (hasFrom && hasTo) throw new Error(`目标目录已存在：${toDir}`);
  if (!hasFrom && !hasTo) console.log('    目录两边都没有，只改数据库');
  if (!apply) return { shelf, planned: true, chars, media };

  let moved = false;
  if (hasFrom) {
    fs.renameSync(fromDir, toDir);
    moved = true;
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE shelves SET name = ?, updated_at = ? WHERE id = ?').run(to, now, shelf.id);
    // 容器条目（表情包 / 收件箱 / 小说 / 散图）的名字就是库名，跟着改
    db.prepare(
      'UPDATE characters SET name = ?, updated_at = ? WHERE shelf_id = ? AND is_container = 1 AND name = ?',
    ).run(to, now, shelf.id, from);
    // substr 从 1 开始按字符算：'人物库/水淼' 取 length+1 之后 = '/水淼'
    db.prepare(
      'UPDATE characters SET dir_slug = ? || substr(dir_slug, ?), updated_at = ? WHERE shelf_id = ? AND (dir_slug = ? OR dir_slug LIKE ?)',
    ).run(to, from.length + 1, now, shelf.id, from, `${from}/%`);
    db.prepare('UPDATE media SET rel_path = ? || substr(rel_path, ?) WHERE rel_path LIKE ?').run(
      to,
      from.length + 1,
      `${from}/%`,
    );
  });

  try {
    tx();
  } catch (err) {
    if (moved) fs.renameSync(toDir, fromDir);
    throw err;
  }
  return { shelf, moved };
}

let failed = 0;
for (const rule of RENAMES) {
  try {
    migrate(rule);
  } catch (err) {
    failed++;
    console.error(`  [x] ${rule.from} 失败：${err.message}`);
  }
}

if (apply) {
  console.log('\n=== 复核 ===');
  for (const { from, to } of RENAMES) {
    const left = db.prepare('SELECT COUNT(*) c FROM media WHERE rel_path LIKE ?').get(`${from}/%`).c;
    const leftChars = db
      .prepare('SELECT COUNT(*) c FROM characters WHERE dir_slug = ? OR dir_slug LIKE ?')
      .get(from, `${from}/%`).c;
    const name = db.prepare('SELECT name FROM shelves WHERE name = ?').get(to);
    // 抽查一条媒体，看文件还在不在
    const one = db.prepare('SELECT rel_path FROM media WHERE rel_path LIKE ? LIMIT 1').get(`${to}/%`);
    const exists = one ? fs.existsSync(path.join(DATA_DIR, one.rel_path)) : true;
    console.log(
      `${from} → ${to}: shelf=${name ? 'ok' : '缺失'} 残留rel_path=${left} 残留dir_slug=${leftChars} 抽样文件=${exists ? 'ok' : (one ? '缺失:' + one.rel_path : '无媒体')}`,
    );
  }
}

console.log(`\n${apply ? '完成' : 'dry-run 结束（加 --apply 执行）'}${failed ? `，${failed} 个失败` : ''}`);
db.close();
process.exit(failed ? 1 : 0);
