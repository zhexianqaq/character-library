/**
 * 命令行导入：把一个或多个外部角色目录导入自己的库。
 *
 * 用法：
 *   node src/import-cli.js "<源目录1>" ["<源目录2>" ...] [--name "显示名"] [--move]
 *
 *   --name "显示名"  只在导入单个目录时生效
 *   --move           搬而不是抄：确认库里已有一份完整副本后删掉源文件，
 *                    并把源目录里空掉的子目录清掉（根目录保留）
 */
import path from 'node:path';
import { getDb, defaultShelfId } from './db.js';
import { importCharacterDir, parseDirName } from './importer.js';

const argv = process.argv.slice(2);
const dirs = [];
let customName = null;
let moveSource = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--move') moveSource = true;
  else if (a === '--name') customName = argv[(i += 1)] || null;
  else if (a.startsWith('--')) console.warn(`[忽略] 不认识的参数：${a}`);
  else dirs.push(a);
}

if (!dirs.length) {
  console.error('用法: node src/import-cli.js "<源目录>" [--name "显示名"] [--move]');
  process.exit(1);
}
if (moveSource) console.log('[模式] --move：入库成功后删除源文件（库里那份不动）');

getDb();
const shelfId = defaultShelfId();
if (!shelfId) {
  console.error('没有可用的角色集');
  process.exit(1);
}

for (const dir of dirs) {
  const abs = path.resolve(dir);
  const base = path.basename(abs);
  const parsed = parseDirName(base);
  const displayName = dirs.length === 1 && customName ? customName : parsed.name;
  console.log(`\n[导入] ${base}`);
  console.log(`       显示名: ${displayName}`);

  let lastTick = 0;
  let result;
  try {
    result = await importCharacterDir({
      shelfId,
      sourceDir: abs,
      name: displayName,
      moveSource,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastTick < 400 && p.done < p.total) return;
        lastTick = now;
        process.stdout.write(`\r       ${p.done}/${p.total}  ${p.skipped ? '[跳过重复]' : ''} ${p.name.slice(0, 50)}          `);
      },
    });
  } catch (err) {
    console.error(`\n       失败：${err.message || err}`);
    process.exitCode = 1;
    continue;
  }
  const bits = [`${result.added} 个媒体`, `${result.packs} 个图包`, `${(result.bytes / 1024 ** 2).toFixed(0)} MB`];
  if (result.skipped) bits.push(`跳过重复 ${result.skipped} 个`);
  if (moveSource) {
    bits.push(`已删源文件 ${result.moved} 个`);
    if (result.prunedDirs) bits.push(`清理空目录 ${result.prunedDirs} 个`);
  }
  console.log(`\n       完成：${bits.join('，')}`);
  if (moveSource && result.keptSources.length) {
    console.log(`       保留源文件 ${result.keptSources.length} 个（复制失败 / 尺寸不一致 / 库里没有实体副本）：`);
    for (const f of result.keptSources.slice(0, 8)) console.log(`         ${f}`);
    if (result.keptSources.length > 8) console.log(`         ……还有 ${result.keptSources.length - 8} 个`);
  }
}
console.log('\n全部完成。');
