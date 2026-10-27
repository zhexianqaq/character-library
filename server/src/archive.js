import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { cleanSegment } from './config.js';

/**
 * 压缩包解压（只做「拆开成散文件」，不认识图片视频）。
 *
 * 为什么自己写 zip：中文压缩包里的文件名大多是 GBK 且没有 UTF-8 标志位，
 * 通用库默认按 UTF-8 解 → 名字全是乱码，而入库后**文件名就是标题、也是月份和标签的来源**，
 * 乱码会一路污染到标签池。这里按「有 UTF-8 标志 → UTF-8；否则先试严格 UTF-8，失败退 GB18030」解，
 * 中文包、老外文包都能拿到正确名字。
 *
 * rar / 7z 的算法没法自己写，交给本机已装的工具（7-Zip → WinRAR UnRAR → Windows 自带 bsdtar）。
 * 一个都没有时明确报错，不要假装解压成功。
 */

const ARCHIVE_RE = /\.(zip|rar|7z|tgz|tar|tar\.gz|tar\.bz2|tar\.xz)$/i;

/** 这些名字出现在压缩包里一律不要：macOS 资源叉 / Windows 缩略图缓存 / 隐藏文件 */
const JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

export function isArchiveName(name) {
  return ARCHIVE_RE.test(String(name || ''));
}

/** 从 zip / rar / 7z 头几个字节判断格式，比扩展名可靠（很多人把 7z 改成 .zip） */
function detectFormat(head, fileName) {
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip'; // 空包
  if (head.length >= 7 && head.subarray(0, 6).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))) return 'rar';
  if (head.length >= 6 && head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar'; // .tar.gz
  if (head.length >= 3 && head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) return 'tar'; // .tar.bz2
  if (head.length >= 6 && head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'tar'; // .tar.xz
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  // 认不出来时按扩展名兜底：交给外部工具试一把，失败再说
  if (/\.zip$/i.test(fileName)) return 'zip';
  if (/\.rar$/i.test(fileName)) return 'rar';
  if (/\.7z$/i.test(fileName)) return '7z';
  if (/\.(tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i.test(fileName)) return 'tar';
  return null;
}

/* ────────────────────────────── zip ────────────────────────────── */

class Crc32 extends Transform {
  constructor() {
    super();
    this.value = 0;
  }
  _transform(chunk, _enc, cb) {
    this.value = zlib.crc32(chunk, this.value);
    cb(null, chunk);
  }
}

async function readExact(fh, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fh.read(buf, read, length - read, position + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

async function findEocd(fh, size) {
  const tailLen = Math.min(size, 66 * 1024);
  const tail = await readExact(fh, size - tailLen, tailLen);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      return { offset: size - tailLen + i, buf: tail.subarray(i) };
    }
  }
  return null;
}

/** 读中央目录；顺带处理 zip64（>4GB 或 >65535 个条目的大包） */
async function readCentralDirectory(fh, size) {
  const eocd = await findEocd(fh, size);
  if (!eocd) throw new Error('不是有效的 zip（找不到目录区，文件可能不完整）');

  let count = eocd.buf.readUInt16LE(10);
  let cenSize = eocd.buf.readUInt32LE(12);
  let cenOffset = eocd.buf.readUInt32LE(16);

  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
    const locOffset = eocd.offset - 20;
    if (locOffset >= 0) {
      const loc = await readExact(fh, locOffset, 20);
      if (loc.length === 20 && loc.readUInt32LE(0) === 0x07064b50) {
        const z64Offset = Number(loc.readBigUInt64LE(8));
        const z64 = await readExact(fh, z64Offset, 56);
        if (z64.length === 56 && z64.readUInt32LE(0) === 0x06064b50) {
          count = Number(z64.readBigUInt64LE(32));
          cenSize = Number(z64.readBigUInt64LE(40));
          cenOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    }
  }
  if (!Number.isFinite(cenSize) || cenSize <= 0) throw new Error('zip 目录区大小异常');
  if (cenSize > 512 * 1024 * 1024) throw new Error('zip 目录区过大（超过 512MB）');

  const cen = await readExact(fh, cenOffset, cenSize);
  const entries = [];
  let p = 0;
  while (p + 46 <= cen.length && cen.readUInt32LE(p) === 0x02014b50) {
    const flags = cen.readUInt16LE(p + 8);
    const method = cen.readUInt16LE(p + 10);
    const crc = cen.readUInt32LE(p + 16);
    let compSize = cen.readUInt32LE(p + 20);
    let uncompSize = cen.readUInt32LE(p + 24);
    const nameLen = cen.readUInt16LE(p + 28);
    const extraLen = cen.readUInt16LE(p + 30);
    const commentLen = cen.readUInt16LE(p + 32);
    const extAttr = cen.readUInt32LE(p + 38);
    let localOffset = cen.readUInt32LE(p + 42);
    const nameBuf = cen.subarray(p + 46, p + 46 + nameLen);
    const extra = cen.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p += 46 + nameLen + extraLen + commentLen;

    // zip64 扩展字段：只补那些被写成 0xFFFFFFFF 的值，顺序固定
    if (extraLen >= 4) {
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const take = () => {
            if (q + 8 > e + 4 + len) return null;
            const v = Number(extra.readBigUInt64LE(q));
            q += 8;
            return v;
          };
          if (uncompSize === 0xffffffff) uncompSize = take() ?? uncompSize;
          if (compSize === 0xffffffff) compSize = take() ?? compSize;
          if (localOffset === 0xffffffff) localOffset = take() ?? localOffset;
          break;
        }
        e += 4 + len;
      }
    }

    const name = decodeZipName(nameBuf, flags);
    entries.push({
      name,
      flags,
      method,
      crc,
      compSize,
      uncompSize,
      localOffset,
      isDir: /[\\/]$/.test(name) || (extAttr & 0x10) !== 0,
    });
    if (entries.length >= count) break;
  }
  return entries;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
let gbkDecoder = null;
try {
  gbkDecoder = new TextDecoder('gb18030');
} catch {
  gbkDecoder = null;
}

function decodeZipName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  try {
    return utf8Strict.decode(buf);
  } catch {
    // 没有 UTF-8 标志又解不出合法 UTF-8 —— 中文包基本都是 GBK
    return gbkDecoder ? gbkDecoder.decode(buf) : buf.toString('latin1');
  }
}

/** 条目名 → 安全的相对路径段列表（拒绝 .. / 绝对路径 / 盘符） */
function safeRelParts(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..' && !/^[a-z]:$/i.test(s))
    .map((s) => cleanSegment(s, 80));
}

async function uniqueTarget(root, parts) {
  let candidate = path.join(root, ...parts);
  if (!fs.existsSync(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext);
  for (let i = 1; i < 999; i += 1) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

async function extractZipEntry(fh, entry, destRoot) {
  const parts = safeRelParts(entry.name);
  if (!parts.length) return null;
  const target = await uniqueTarget(destRoot, parts);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  const lh = await readExact(fh, entry.localOffset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('本地文件头损坏');
  // 中央目录里的 extra 长度和本地头的不一定一样，必须按本地头重新算数据起点
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

  if (entry.compSize === 0) {
    await fsp.writeFile(target, Buffer.alloc(0));
    return { target, bytes: 0, crcOk: entry.crc === 0 };
  }

  const crc = new Crc32();
  const out = fs.createWriteStream(target);
  const source = fh.createReadStream({
    start: dataStart,
    end: dataStart + entry.compSize - 1,
    autoClose: false, // 关了就会把共享的 FileHandle 一起关掉，后面的条目全读不了
  });

  if (entry.method === 0) {
    await pipeline(source, crc, out);
  } else if (entry.method === 8) {
    await pipeline(source, zlib.createInflateRaw(), crc, out);
  } else {
    throw new Error(`不支持的压缩方式（method=${entry.method}），请用 7-Zip 重打一次`);
  }

  return { target, bytes: entry.uncompSize, crcOk: crc.value === (entry.crc >>> 0) };
}

async function extractZip(fh, size, destRoot) {
  const entries = await readCentralDirectory(fh, size);
  // general purpose bit 0 = 加密。纯 JS 解不了 ZipCrypto/AES，直接说清楚而不是给一堆乱码。
  const locked = entries.filter((e) => e.flags & 0x1 && !e.isDir);
  if (locked.length) {
    const err = new Error('加密的 zip 没法在站内解压，请用 7-Zip / WinRAR 解开后拖文件夹进来（rar / 7z 可以直接输密码）');
    err.code = 'ZIP_ENCRYPTED';
    throw err;
  }
  const files = [];
  const skipped = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDir) continue;
    if (JUNK_RE.test(entry.name.replace(/\\/g, '/'))) continue;
    if (entry.flags & 0x1) {
      skipped.push({ name: entry.name, reason: '加密条目' });
      continue;
    }
    totalBytes += entry.uncompSize || 0;
    // 解压炸弹：小包解出几百 G，直接把盘写满
    if (totalBytes > 50 * 1024 ** 3) throw new Error('压缩包解压后超过 50GB，已中止');
    try {
      const out = await extractZipEntry(fh, entry, destRoot);
      if (!out) continue;
      if (!out.crcOk) {
        skipped.push({ name: entry.name, reason: '校验失败（文件可能已损坏）' });
        await fsp.unlink(out.target).catch(() => {});
        continue;
      }
      files.push({ abs: out.target, name: path.basename(out.target), size: out.bytes });
    } catch (err) {
      skipped.push({ name: entry.name, reason: err.message || '解压失败' });
    }
  }
  return { format: 'zip', files, skipped };
}

/* ─────────────────────── rar / 7z / tar 外部工具 ─────────────────────── */

const WIN = process.platform === 'win32';

function firstExisting(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function which(cmd) {
  const exts = WIN ? ['.exe', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function toolPath(envKey, name, known) {
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return firstExisting(known) || which(name);
}

const sevenZip = () =>
  toolPath('CL_7Z', '7z', [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]) || toolPath('CL_7ZA', '7za', []);

const unrar = () =>
  toolPath('CL_UNRAR', 'UnRAR', [
    'C:\\Program Files\\WinRAR\\UnRAR.exe',
    'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe',
  ]);

const bsdtar = () =>
  toolPath('CL_BSDTAR', 'tar', [
    'C:\\Windows\\System32\\tar.exe', // Win10 1803+ 自带，libarchive，能读 zip/7z/rar
  ]);

/** 跑一个外部命令，收集输出；超时 30 分钟（解 20GB 的包也够了） */
/** UnRAR / 7-Zip 在中文 Windows 上按 GBK 输出，直接 UTF-8 解会变成乱码，认不出「密码不正确」 */
function decodeOutput(buf) {
  if (!buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function run(cmd, args, { timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    // stdin 必须显式 ignore：UnRAR 遇到加密包会去读 stdin 等密码，
    // 而 spawn 默认给的是永不关闭的管道 —— 表现成「解压永远不结束」。
    // 密码要靠 -p<密码> 传，绝不走交互。
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const outBufs = [];
    const errBufs = [];
    let outLen = 0;
    let errLen = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(cmd)} 超时未结束`));
    }, timeout);
    child.stdout.on('data', (c) => {
      if (outLen < 60000) {
        outBufs.push(c);
        outLen += c.length;
      }
    });
    child.stderr.on('data', (c) => {
      if (errLen < 60000) {
        errBufs.push(c);
        errLen += c.length;
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        out: decodeOutput(Buffer.concat(outBufs)),
        err: decodeOutput(Buffer.concat(errBufs)),
      });
    });
  });
}

async function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  // 外部工具铺出来的目录顺序不可控，按名字自然序排（1、2、10），漫画页序才正常
  return out.sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  );
}

async function extractWithTool(format, archiveAbs, destRoot, password = '') {
  // -p- 表示「用空密码、别再问我」：没有它，UnRAR 遇到加密包会等 stdin 输入密码，
  // 表现成「解压永远不结束」—— 用户那个 77MB 的包就是卡在这里。
  const pwd = password ? `-p${password}` : '-p-';
  const attempts = [];
  if (format === 'rar') {
    const un = unrar();
    if (un)
      attempts.push({
        cmd: un,
        args: ['x', '-y', '-o+', '-idq', pwd, archiveAbs, destRoot + path.sep],
        name: 'UnRAR',
      });
  }
  const sz = sevenZip();
  if (sz) attempts.push({ cmd: sz, args: ['x', '-y', '-bd', pwd, `-o${destRoot}`, archiveAbs], name: '7-Zip' });
  // bsdtar 不能解密：喂它加密包它会「成功」吐出一堆 0 内容文件（实测 658 字节、
  // 文件头 00 00 00），所以只在纯 tar 上用它，rar / 7z 一律走能带密码的工具
  if (format === 'tar') {
    const bt = bsdtar();
    if (bt) attempts.push({ cmd: bt, args: ['-xf', archiveAbs, '-C', destRoot], name: 'bsdtar' });
  }

  if (!attempts.length) {
    throw new Error(
      `这台机器没有能解 ${format} 的工具。装个 7-Zip 就好（zip 不需要），或者先把包手动解压再拖进来。`
    );
  }

  const errors = [];
  let pwdProblem = false;
  for (const a of attempts) {
    try {
      const r = await run(a.cmd, a.args);
      const files = await walkFiles(destRoot);
      const text = `${r.err} ${r.out}`;
      // 密码问题不必再换工具试：换谁都是同一个结果，只会多等一轮
      if (!files.length && /password|密码|encrypted|incorrect|不正确/i.test(text)) {
        pwdProblem = true;
        errors.push(`${a.name}: ${text.trim().slice(0, 200)}`);
        break;
      }
      // 有的工具退出码非 0 但文件其实解出来了（比如个别条目报错），以有没有文件为准
      if (files.length || r.code === 0) return { files, tool: a.name, log: (r.err || r.out).slice(0, 500) };
      errors.push(`${a.name}: ${(r.err || r.out || `退出码 ${r.code}`).trim().slice(0, 200)}`);
    } catch (err) {
      errors.push(`${a.name}: ${err.message}`);
    }
  }

  const all = errors.join(' ');
  if (pwdProblem || /password|密码|encrypted|incorrect|不正确/i.test(all)) {
    const err = new Error(
      password ? '密码不对，解压失败' : '这个压缩包有密码，需要输入密码才能解压'
    );
    err.code = password ? 'BAD_PASSWORD' : 'NEED_PASSWORD';
    throw err;
  }
  const err = new Error(`解压失败 —— ${all || '没有可用的解压工具'}`);
  err.code = 'ARCHIVE_FAILED';
  throw err;
}

/* ────────────────────────────── 对外入口 ────────────────────────────── */

/**
 * 把压缩包解到 destDir（调用方负责建和清）。
 * 加密包要传 password；没传且确实是加密包时抛 code='NEED_PASSWORD'。
 * 返回 { format, files:[{abs,name,size}], skipped:[{name,reason}], tool }
 */
export async function extractArchive(archiveAbs, destDir, { password = '' } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const st = await fsp.stat(archiveAbs);
  if (!st.size) throw new Error('压缩包是空的');

  const fh = await fsp.open(archiveAbs, 'r');
  let format = null;
  try {
    const head = await readExact(fh, 0, 512);
    format = detectFormat(head, archiveAbs);
    if (!format) throw new Error('认不出这个压缩包（支持 zip / rar / 7z / tar.gz）');
    if (format === 'zip') return await extractZip(fh, st.size, destDir);
  } finally {
    await fh.close().catch(() => {});
  }

  const res = await extractWithTool(format, archiveAbs, destDir, password);
  const files = res.files.map((abs) => ({
    abs,
    name: path.basename(abs),
    size: fs.statSync(abs).size,
  }));
  return { format, files, skipped: [], tool: res.tool };
}
