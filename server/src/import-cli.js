/**
 * 命令行导入：把一个或多个外部角色目录复制进自己的库。
 * 用法：node src/import-cli.js "<源目录1>" ["<源目录2>" ...]
 *     可选 --name "显示名" 作用于单个目录
 */
import path from 'node:path';
import { getDb, defaultShelfId } from './db.js';
import { importCharacterDir, parseDirName } from './importer.js';

const argv = process.argv.slice(2);
const nameFlag = argv.indexOf('--name');
const customName = nameFlag >= 0 ? argv[nameFlag + 1] : null;
const dirs = argv.filter((a, i) => !a.startsWith('--') && i !== nameFlag + 1);

if (!dirs.length) {
  console.error('用法: node src/import-cli.js "<源目录>" [--name "显示名"]');
  process.exit(1);
}

getDb();
const shelfId = defaultShelfId();
if (!shelfId) {
  console.error('没有可用的角色库');
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
  const result = await importCharacterDir({
    shelfId,
    sourceDir: abs,
    name: displayName,
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastTick < 400 && p.done < p.total) return;
      lastTick = now;
      process.stdout.write(`\r       ${p.done}/${p.total}  ${p.skipped ? '[跳过重复]' : ''} ${p.name.slice(0, 50)}          `);
    },
  });
  console.log(`\n       完成：${result.added} 个媒体，${result.packs} 个图包，${(result.bytes / 1024 ** 2).toFixed(0)} MB`);
}
console.log('\n全部完成。');
