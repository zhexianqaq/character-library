import { exec } from 'node:child_process';
import { PORT, HOST, DATA_DIR, CACHE_DIR, assertStorageReady } from './config.js';
import { createApp } from './routes.js';
import { getDb, mainLibrary } from './db.js';
import { sweepOrphanPosters } from './thumbs.js';
import { recoverPendingMoves } from './file-journal.js';

assertStorageReady();

const db = getDb();
mainLibrary();
// 上次跨角色搬运如果中途被杀，这里按 journal 收尾（搬回或确认已提交）
const recovered = await recoverPendingMoves(db).catch((err) => {
  console.error('  搬运日志  收尾失败：', err.message);
  return null;
});
if (recovered && recovered.scanned) {
  for (const d of recovered.details) console.log(`              · ${d}`);
}
// 删条目 / 删图包只删行，封面文件不会跟着走；启动时顺手清一遍孤儿
sweepOrphanPosters().catch(() => {});
const app = createApp();

app.listen(PORT, HOST, () => {
  const t = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM shelves) shelves,
              (SELECT COUNT(*) FROM characters) characters,
              (SELECT COUNT(*) FROM media) media,
              (SELECT COUNT(*) FROM packs) packs`
    )
    .get();

  console.log('');
  console.log('  资料库 · 角色库');
  console.log(`  数据（E 盘）  ${DATA_DIR}`);
  console.log(`  缓存（D 盘）  ${CACHE_DIR}`);
  console.log(`  内容          ${t.shelves} 个角色库 · ${t.characters} 个角色 · ${t.packs} 个图包 · ${t.media} 个媒体`);
  console.log(`  访问地址      http://${HOST}:${PORT}`);
  console.log('');

  if (process.argv.includes('--open')) {
    setTimeout(() => {
      exec(`cmd /c start "" "http://${HOST}:${PORT}"`, () => {});
    }, 900);
  }
});
