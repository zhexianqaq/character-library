/**
 * 把所有「官图」目录里的素材退回「全部库 → 未分发」，但**保留鸣潮**。
 *
 * 判定用的是磁盘路径 `%/官图/%`，不是 packs.category ——
 * 官图小库里还有一批「未分类」包的媒体，它们不在 category='官图' 的包里，
 * 但同样躺在 `<角色>/官图/未分类/图片/`，按包筛会漏。
 *
 * 用法：node tools/eject-official.mjs                      # 只统计（默认整个「官图」小库）
 *       node tools/eject-official.mjs --apply              # 真搬
 *       node tools/eject-official.mjs --keep 鸣潮 --apply   # 保留某个作品（按出处 / 标签判定）
 *       node tools/eject-official.mjs --dir /cosplay/ --apply  # 换个目录片段
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.CL_DATA_DIR || 'E:/CharacterLibrary';
const BASE = process.env.CL_BASE || 'http://127.0.0.1:7788';
const APPLY = process.argv.includes('--apply');

/** --keep 鸣潮：这个作品（出处或标签命中）的素材不动；不传就全退 */
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
};
const KEEP = argOf('--keep');
/** 目录片段：默认官图小库 */
const DIR = argOf('--dir') || '/官图/';

const db = new Database(path.join(DATA, '.catalog', 'library.db'), { readonly: true });
db.pragma('busy_timeout = 8000');

const keepIds = KEEP
  ? db
      .prepare(
        `SELECT c.id FROM characters c
          WHERE c.is_container = 0 AND (
            c.platforms LIKE @like OR
            EXISTS (SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
                     WHERE ct.character_id = c.id AND t.name = @name))`
      )
      .all({ like: `%"handle":"${KEEP}"%`, name: KEEP })
      .map((r) => r.id)
  : [];
const keepSet = new Set(keepIds);
const all = db
  .prepare(
    `SELECT m.id, m.kind, m.file_name, m.character_id, c.name AS char_name
       FROM media m JOIN characters c ON c.id = m.character_id
      WHERE c.is_container = 0 AND m.rel_path LIKE @dir
      ORDER BY m.id`
  )
  .all({ dir: `%${DIR}%` });

const move = all.filter((m) => !keepSet.has(m.character_id));
const keep = all.filter((m) => keepSet.has(m.character_id));

console.log(`「${DIR}」目录下共 ${all.length} 条`);
if (KEEP) console.log(`  保留（${KEEP}）      ${keep.length} 条 / ${new Set(keep.map((m) => m.character_id)).size} 个角色`);
console.log(`  退到全部库        ${move.length} 条 / ${new Set(move.map((m) => m.character_id)).size} 个角色`);
console.log(`  其中图片 ${move.filter((m) => m.kind === 'image').length} / 视频 ${move.filter((m) => m.kind === 'video').length}`);

if (!APPLY) {
  console.log('\n（只是统计，没动任何文件。加 --apply 才执行）');
  process.exit(0);
}

const ids = move.map((m) => m.id);
const BATCH = 150;
let moved = 0;
let merged = 0;
const skipped = [];
const failed = [];

for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  process.stdout.write(`\n第 ${i / BATCH + 1} 批（${chunk.length} 条）… `);
  try {
    const r = await fetch(`${BASE}/api/media/eject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: chunk }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    moved += j.moved || 0;
    merged += j.merged || 0;
    if (Array.isArray(j.skipped)) skipped.push(...j.skipped);
    process.stdout.write(`ok  moved=${j.moved} merged=${j.merged} skipped=${(j.skipped || []).length}`);
  } catch (err) {
    failed.push({ chunk: `${i}-${i + chunk.length}`, error: err.message });
    process.stdout.write(`失败：${err.message}`);
  }
}

console.log('\n\n=== 结果 ===');
console.log(`已移出 ${moved} 条，合并 ${merged} 条，跳过 ${skipped.length} 条，失败批次 ${failed.length}`);
if (skipped.length) console.log('跳过示例：', skipped.slice(0, 5));
if (failed.length) console.log('失败：', failed);
db.close();
