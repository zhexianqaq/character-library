/**
 * 给一个文件夹设置自定义图标（资源管理器里显示成图标，而不是黄文件夹）。
 *
 * 原理就三件事，缺一个都不生效：
 *   1. 目录里放 `desktop.ini`，内容 `[.ShellClassInfo]` + `IconResource=<ico绝对路径>,0`
 *   2. `desktop.ini` 加 隐藏 + 系统 属性，目录本身加 系统 属性（否则 shell 不读它）
 *   3. 通知 shell 刷新图标缓存（`ie4uinit.exe -show`）
 *
 * 为什么用 Node 而不是 .ps1：`desktop.ini` 要 UTF-16 LE（中文路径必须），
 * 而 Windows PowerShell 5.1 跑 UTF-8 无 BOM 的 .ps1 遇到中文注释会解析失败。
 * Node 写文件按字节控制编码，没有这个坑。
 *
 * desktop.ini 已被 .gitignore 排除，所以这是「本机设置」而非仓库内容 ——
 * 换机器或重新 clone 后重跑一次即可。
 *
 * 用法：
 *   node tools/set-folder-icon.mjs                 # 默认给程序目录和数据目录都设
 *   node tools/set-folder-icon.mjs <目录> [目录…]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../server/src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const icon = path.join(root, 'desktop', 'assets', 'icon.ico');

if (!fs.existsSync(icon)) {
  console.error(`[x] 找不到图标：${icon}\n    先跑 node desktop/make-icon.mjs`);
  process.exit(1);
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [root, DATA_DIR];

for (const dir of targets) {
  if (!fs.existsSync(dir)) {
    console.log(`- ${dir}: 不存在，跳过`);
    continue;
  }
  const ini = path.join(dir, 'desktop.ini');
  // 已存在就先摘掉 隐藏/系统 属性 —— 带这两个属性的文件很多环境不让直接覆盖（EPERM）
  if (fs.existsSync(ini)) {
    try {
      execFileSync('attrib', ['-s', '-h', ini]);
    } catch {
      /* 摘不掉就试着直接写 */
    }
  }
  // UTF-16 LE + CRLF：shell 对 desktop.ini 的编码很挑，这条最稳
  const body = `[.ShellClassInfo]\r\nIconResource=${icon},0\r\n`;
  fs.writeFileSync(ini, Buffer.from(body, 'utf16le'));

  // attrib 对已设置的属性是幂等的，重复跑不会出事
  execFileSync('attrib', ['+s', '+h', ini]);
  execFileSync('attrib', ['+s', dir]);
  console.log(`- ${dir}: desktop.ini 已写入（IconResource=${icon}）`);
}

try {
  execFileSync('ie4uinit.exe', ['-show']);
  console.log('- 图标缓存刷新已触发（资源管理器可能要按 F5 才更新）');
} catch {
  console.log('- ie4uinit 调用失败，手动按 F5 刷新资源管理器即可');
}
