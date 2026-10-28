/**
 * 给一个文件夹设置自定义图标（资源管理器里显示成图标，而不是黄文件夹）。
 *
 * 原理就三件事，缺一个都不生效：
 *   1. 目录里放 `desktop.ini`，内容 `[.ShellClassInfo]` + `IconResource=<ico绝对路径>,0`
 *   2. `desktop.ini` 加 隐藏 + 系统 属性，目录本身加 系统 属性（否则 shell 不读它）
 *   3. 通知 shell 刷新图标缓存（`ie4uinit.exe -show`）
 *
 * 默认给这些目录配图标：
 *   - 程序目录（仓库根）→ `desktop/assets/icon.ico`          书本
 *   - 数据目录（CL_DATA_DIR）→ `desktop/assets/icon-data.ico` 角色抱着文件
 *   - 八个库目录 → `desktop/assets/shelves/<kind>.ico`        从数据库现读库名
 *   - `.catalog` / `.covers` → `desktop/assets/meta/*.ico`    元数据目录
 *
 * 为什么用 Node 而不是 .ps1：`desktop.ini` 要 UTF-16 LE（中文路径必须），
 * 而 Windows PowerShell 5.1 跑 UTF-8 无 BOM 的 .ps1 遇到中文注释会解析失败。
 * Node 写文件按字节控制编码，没有这个坑。
 *
 * desktop.ini 已被 .gitignore 排除，所以这是「本机设置」而非仓库内容 ——
 * 换机器或重新 clone 后重跑一次即可。
 *
 * 用法：
 *   node tools/set-folder-icon.mjs                                   # 两个默认目录
 *   node tools/set-folder-icon.mjs D:\a E:\b --icon=path\to\x.ico    # 指定目录 + 同一个图标
 *   node tools/set-folder-icon.mjs --icon=desktop/assets/icon-data.ico  # 换掉默认图标
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE } from '../server/src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const dirArgs = argv.filter((a) => !a.startsWith('--'));
const iconArg = argv.find((a) => a.startsWith('--icon='));
const explicitIcon = iconArg ? path.resolve(iconArg.slice('--icon='.length)) : null;

/** 库类型 → shelves/<名字>.ico */
const SHELF_ICON = {
  people: 'people.ico',
  work: 'work.ico',
  emoji: 'emoji.ico',
  resource: 'resource.ico',
  inbox: 'inbox.ico',
  loose: 'loose.ico',
};

function shelfIcon(kind, variant) {
  if (kind === 'novel') return variant === 'fanfic' ? 'novel-fanfic.ico' : 'novel-original.ico';
  return SHELF_ICON[kind] || null;
}

/**
 * 数据目录下的两个元数据目录。它们不是「库」，没有 shelves 记录，
 * 单独挂图标 —— 否则夹在八个彩色库目录中间会显得像漏掉了。
 */
const META_ICON = [
  ['.catalog', 'catalog.ico'], // 索引库：文件夹 + 文档 + 星轨
  ['.covers', 'covers.ico'], // 自定义封面：文件夹 + 相片
];

/**
 * 默认：程序目录用书本、数据目录用角色，八个库目录各挂自己的图标。
 *
 * 库名从数据库现读 —— 库里改过名（v3.55 那轮）也不会错位；
 * 目录不存在就跳过，不会硬造。
 */
function defaultPlan() {
  const plan = [
    { dir: root, icon: path.join(root, 'desktop', 'assets', 'icon.ico') },
    { dir: DATA_DIR, icon: path.join(root, 'desktop', 'assets', 'icon-data.ico') },
  ];

  try {
    const require = createRequire(path.join(root, 'server', 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(DB_FILE, { readonly: true });
    const shelves = db.prepare('SELECT name, kind, variant FROM shelves ORDER BY sort_order, id').all();
    db.close();
    for (const s of shelves) {
      const ico = shelfIcon(s.kind, s.variant);
      if (!ico) continue;
      plan.push({
        dir: path.join(DATA_DIR, s.name),
        icon: path.join(root, 'desktop', 'assets', 'shelves', ico),
      });
    }
  } catch (err) {
    console.log(`- 读库失败，跳过库目录：${err.message}`);
  }

  for (const [name, ico] of META_ICON) {
    plan.push({
      dir: path.join(DATA_DIR, name),
      icon: path.join(root, 'desktop', 'assets', 'meta', ico),
    });
  }

  return plan;
}

/** 指定了目录就全部用同一个图标（--icon 优先，否则程序图标） */
function planFromDirs() {
  const icon = explicitIcon || path.join(root, 'desktop', 'assets', 'icon.ico');
  return dirArgs.map((d) => ({ dir: path.resolve(d), icon }));
}

const plan = dirArgs.length ? planFromDirs() : defaultPlan();

for (const { dir, icon } of plan) {
  if (!fs.existsSync(dir)) {
    console.log(`- ${dir}: 不存在，跳过`);
    continue;
  }
  if (!fs.existsSync(icon)) {
    console.error(`[x] ${dir}: 找不到图标 ${icon}`);
    console.error('    先跑 node desktop/make-icon.mjs（或带参数生成对应 ico）');
    process.exitCode = 1;
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
  console.log(`- ${dir}: ${path.basename(icon)}`);
}

try {
  execFileSync('ie4uinit.exe', ['-show']);
  console.log('- 图标缓存刷新已触发（资源管理器可能要按 F5 才更新）');
} catch {
  console.log('- ie4uinit 调用失败，手动按 F5 刷新资源管理器即可');
}
