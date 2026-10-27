/**
 * 一键构建桌面壳：cargo build --release → 拷到项目根当「资料库.exe」。
 *
 * 为什么用 Node 而不是 .bat：exe 名字带中文，cmd 批处理按 GBK 读文件，
 * 脚本存 UTF-8 就会找不到文件；Node 处理路径天然是 UTF-16，没有这个坑。
 *
 * 用法：node desktop/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(here, 'target', 'release', 'ams-desktop.exe');
const out = path.join(root, '资料库.exe');

console.log('[build] cargo build --release');
execFileSync(process.env.CARGO || 'cargo', ['build', '--release'], {
  cwd: here,
  stdio: 'inherit',
});

try {
  copyFileSync(src, out);
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
    console.error('[x] 资料库.exe 正在运行，先关掉那个窗口再构建');
    process.exit(1);
  }
  throw err;
}
const kb = Math.round(statSync(out).size / 1024);
console.log(`[ok] ${out} (${kb} KB)`);
