import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { cleanFileSegment } from './config.js';
import { kindOfExt } from './store.js';

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

/**
 * ZipCrypto（传统 PKWARE 加密）解密。
 *
 * 国内工具打的包（Bandizip / WinRAR / 各种网盘）九成都是这一种，不是 AES。
 * 算法很小：三个 32 位密钥 + 每个明文字节反推出一个密钥流字节。
 * 自己实现是为了不依赖 7-Zip —— 这台机器上没装，WinRAR 又只能命令行走 GUI。
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

class ZipCrypto {
  constructor(password) {
    this.k0 = 0x12345678;
    this.k1 = 0x23456789;
    this.k2 = 0x34567890;
    const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
    for (const b of pw) this.update(b);
  }

  crc(b, c) {
    return (CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  }

  update(b) {
    this.k0 = this.crc(b, this.k0) >>> 0;
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = this.crc(this.k1 >>> 24, this.k2) >>> 0;
  }

  byte() {
    const t = (this.k2 | 2) & 0xffff;
    return ((Math.imul(t, t ^ 1) >>> 8) & 0xff) >>> 0;
  }

  /** 原地解密。注意：密钥是用**明文**推进的，不是密文 */
  decrypt(buf) {
    for (let i = 0; i < buf.length; i += 1) {
      const plain = buf[i] ^ this.byte();
      this.update(plain);
      buf[i] = plain;
    }
    return buf;
  }
}

/**
 * 逐块解密的 Transform：喂给 zlib 之前把密文流解掉。
 * 可以接密码，也可以接一个**已经推进过 12 字节加密头**的 ZipCrypto —— 后者才是对的：
 * 密钥状态必须从加密头之后继续，重新 new 一遍等于从零开始，解出来全是乱码。
 */
class ZipDecrypt extends Transform {
  constructor(pw) {
    super();
    this.cipher = pw instanceof ZipCrypto ? pw : new ZipCrypto(pw);
  }

  _transform(chunk, _enc, cb) {
    cb(null, this.cipher.decrypt(Buffer.from(chunk)));
  }
}

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
    const modTime = cen.readUInt16LE(p + 12); // 开了数据描述符时，加密校验位要用它
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
      modTime,
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
    .map((s) => cleanFileSegment(s, 80));
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

async function extractZipEntry(fh, entry, destRoot, password = '') {
  const parts = safeRelParts(entry.name);
  if (!parts.length) return null;
  const target = await uniqueTarget(destRoot, parts);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  const lh = await readExact(fh, entry.localOffset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('本地文件头损坏');
  // 中央目录里的 extra 长度和本地头的不一定一样，必须按本地头重新算数据起点
  let dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

  if (entry.compSize === 0) {
    await fsp.writeFile(target, Buffer.alloc(0));
    return { target, bytes: 0, crcOk: entry.crc === 0 };
  }

  // 加密条目：前 12 字节是加密头，用来校验密码对不对，剩下的才是数据
  let cipher = null;
  if (entry.flags & 0x1) {
    const header = await readExact(fh, dataStart, 12);
    if (header.length < 12) throw new Error('加密头损坏');
    cipher = new ZipCrypto(password);
    cipher.decrypt(header);
    // 校验位：不开数据描述符时是 CRC 的最高字节，开了是修改时间的次高字节
    const check = entry.flags & 0x8 ? (entry.modTime >>> 8) & 0xff : (entry.crc >>> 24) & 0xff;
    if (header[11] !== check) {
      const err = new Error('密码不对，解压失败');
      err.code = 'BAD_PASSWORD';
      throw err;
    }
    dataStart += 12;
  }

  const crc = new Crc32();
  const out = fs.createWriteStream(target);
  const source = fh.createReadStream({
    start: dataStart,
    end: dataStart + (entry.compSize - (cipher ? 12 : 0)) - 1,
    autoClose: false, // 关了就会把共享的 FileHandle 一起关掉，后面的条目全读不了
  });
  const chain = cipher ? [source, new ZipDecrypt(cipher)] : [source];

  if (entry.method === 0) {
    await pipeline(...chain, crc, out);
  } else if (entry.method === 8) {
    await pipeline(...chain, zlib.createInflateRaw(), crc, out);
  } else {
    throw new Error(`不支持的压缩方式（method=${entry.method}），请用 7-Zip 重打一次`);
  }

  return { target, bytes: entry.uncompSize, crcOk: crc.value === (entry.crc >>> 0) };
}

async function extractZip(fh, size, destRoot, { password = '' } = {}) {
  const entries = await readCentralDirectory(fh, size);
  // general purpose bit 0 = 加密。ZipCrypto 自己能解（v3.69），AES 那种只能在条目上认出来再报错。
  const locked = entries.filter((e) => e.flags & 0x1 && !e.isDir);
  // method 99 = AES 加密（WinRAR / 7-Zip 的「强加密」）。ZipCrypto 能自己解，AES 不行。
  if (locked.some((e) => e.method === 99)) {
    const err = new Error('这是 AES 加密的 zip，站内解不了 —— 用 7-Zip / WinRAR 解开后把文件夹拖进来');
    err.code = 'ZIP_AES';
    throw err;
  }
  if (locked.length && !password) {
    const err = new Error('这个压缩包有密码，需要输入密码才能解压');
    err.code = 'NEED_PASSWORD';
    throw err;
  }
  const files = [];
  const skipped = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDir) continue;
    if (JUNK_RE.test(entry.name.replace(/\\/g, '/'))) continue;
    totalBytes += entry.uncompSize || 0;
    // 解压炸弹：小包解出几百 G，直接把盘写满
    if (totalBytes > 50 * 1024 ** 3) throw new Error('压缩包解压后超过 50GB，已中止');
    try {
      const out = await extractZipEntry(fh, entry, destRoot, password);
      if (!out) continue;
      if (!out.crcOk) {
        skipped.push({ name: entry.name, reason: '校验失败（文件可能已损坏）' });
        await fsp.unlink(out.target).catch(() => {});
        continue;
      }
      files.push({ abs: out.target, name: path.basename(out.target), size: out.bytes });
    } catch (err) {
      // 密码错了要整包失败（让上层去问密码），不能记成一条跳过
      if (err.code === 'BAD_PASSWORD') throw err;
      skipped.push({ name: entry.name, reason: err.message || '解压失败' });
    }
  }
  return { format: 'zip', files, skipped };
}

/* ────────────────────────────── tar ────────────────────────────── */

/**
 * 纯 JS 解 tar（含 .tar.gz）。
 *
 * 为什么不交给 Windows 自带的 bsdtar：它把 tar 里的 UTF-8 文件名按本地代码页
 * （GBK）解释，解出来是「瑙ｅ帇瀵嗙爜」这种乱码 —— 而文件名就是标题、也是标签
 * 和月份分组的来源，乱码会一路污染到标签池。
 *
 * tar 的结构简单：512 字节头 + 数据 + 补零到 512，所以自己读最稳。
 * 顺带还省掉了「这台机器有没有装 7-Zip」这个前提。
 */

/** 按需读字节，处理跨块拼接；大文件不能整包读进内存 */
class BlockReader {
  constructor(stream) {
    this.it = stream[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.eof = false;
  }

  async fill(n) {
    while (this.buf.length < n && !this.eof) {
      const { value, done } = await this.it.next();
      if (done) {
        this.eof = true;
        break;
      }
      this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    }
    return this.buf.length >= n;
  }

  async take(n) {
    if (n <= 0) return Buffer.alloc(0);
    if (!(await this.fill(n))) {
      const out = this.buf;
      this.buf = Buffer.alloc(0);
      return out;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** 把接下来 n 字节写进文件，返回实际写入字节数 */
  async drain(toFile, n) {
    const out = fs.createWriteStream(toFile);
    let left = n;
    const put = (chunk) =>
      new Promise((resolve, reject) => {
        if (!chunk.length) return resolve();
        if (out.write(chunk)) return resolve();
        out.once('drain', resolve);
        out.once('error', reject);
      });

    if (this.buf.length) {
      const chunk = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(chunk.length);
      left -= chunk.length;
      await put(chunk);
    }
    while (left > 0 && !this.eof) {
      const { value, done } = await this.it.next();
      if (done) {
        this.eof = true;
        break;
      }
      const chunk = value.subarray(0, Math.min(left, value.length));
      const rest = value.subarray(chunk.length);
      if (rest.length) this.buf = Buffer.concat([rest, this.buf]);
      left -= chunk.length;
      await put(chunk);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    return n - left;
  }
}

/** tar 头里的数字：八进制 ASCII；超大文件用 GNU base-256（最高位为 1） */
function tarNumber(buf) {
  if (buf[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < buf.length; i += 1) n = n * 256 + buf[i];
    return n;
  }
  const t = buf.toString('latin1').replace(/\0.*$/, '').trim();
  return t ? parseInt(t, 8) || 0 : 0;
}

/** tar 里的文本（文件名 / 链接名）：现代工具写 UTF-8，老的中文工具写 GBK */
function tarText(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end -= 1;
  const raw = buf.subarray(0, end);
  if (!raw.length) return '';
  try {
    return utf8Strict.decode(raw);
  } catch {
    return gbkDecoder ? gbkDecoder.decode(raw) : raw.toString('latin1');
  }
}

function tarString(buf) {
  const zero = buf.indexOf(0);
  return tarText(zero === -1 ? buf : buf.subarray(0, zero));
}

async function extractTar(archiveAbs, destRoot, { gzip = false } = {}) {
  let stream = fs.createReadStream(archiveAbs);
  if (gzip) stream = stream.pipe(zlib.createGunzip());
  const rd = new BlockReader(stream);

  const files = [];
  const skipped = [];
  let totalBytes = 0;
  let longName = '';
  let paxPath = '';
  let blocks = 0;

  for (;;) {
    const block = await rd.take(512);
    if (block.length < 512) break;
    // 连续两个全零块 = 归档结束；这里只看单块
    if (!block.some((b) => b !== 0)) break;
    blocks += 1;
    if (blocks > 200000) throw new Error('tar 条目超过 20 万，已中止');

    const type = String.fromCharCode(block[156] || 0x30);
    const size = tarNumber(block.subarray(124, 136));
    const pad = (512 - (size % 512)) % 512;

    // GNU 长文件名：内容就是下一个头要用的名字
    if (type === 'L') {
      const payload = await rd.take(size);
      longName = tarText(payload);
      await rd.take(pad);
      continue;
    }
    // PAX 扩展头：path= 覆盖真名（Bandizip / bsdtar 打的长中文名走这条）
    if (type === 'x' || type === 'X') {
      const payload = await rd.take(size);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(payload.toString('utf8'));
      if (m) paxPath = m[1];
      await rd.take(pad);
      continue;
    }
    if (type === 'g') {
      await rd.take(size);
      await rd.take(pad);
      continue;
    }

    let name;
    if (longName) {
      name = longName;
      longName = '';
    } else if (paxPath) {
      name = paxPath;
      paxPath = '';
    } else {
      const pre = tarString(block.subarray(345, 500));
      const base = tarString(block.subarray(0, 100));
      name = pre ? `${pre}/${base}` : base;
    }

    const isDir = type === '5' || /[\\/]$/.test(name);
    const isLink = type === '1' || type === '2' || type === '3' || type === '4' || type === '6';

    if (!name || isDir) {
      await rd.take(size);
      await rd.take(pad);
      continue;
    }
    if (isLink) {
      skipped.push({ name, reason: '链接条目，跳过' });
      await rd.take(size);
      await rd.take(pad);
      continue;
    }
    if (JUNK_RE.test(name.replace(/\\/g, '/'))) {
      await rd.take(size);
      await rd.take(pad);
      continue;
    }

    totalBytes += size;
    if (totalBytes > 50 * 1024 ** 3) throw new Error('压缩包解压后超过 50GB，已中止');

    const parts = safeRelParts(name);
    if (!parts.length) {
      await rd.take(size);
      await rd.take(pad);
      continue;
    }
    const target = await uniqueTarget(destRoot, parts);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      const bytes = await rd.drain(target, size);
      await rd.take(pad);
      files.push({ abs: target, name: path.basename(target), size: bytes });
    } catch (err) {
      skipped.push({ name, reason: err.message || '写入失败' });
      await fsp.unlink(target).catch(() => {});
      await rd.take(pad);
    }
  }

  if (stream.destroy) stream.destroy();
  return { format: gzip ? 'tar.gz' : 'tar', files, skipped, tool: 'native' };
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
const NESTED_MAX_DEPTH = 2;
const NESTED_MAX_INNER = 4;

function hasMediaFile(files) {
  return files.some((f) => ['image', 'video'].includes(kindOfExt(path.extname(f.name))));
}

/**
 * 嵌套压缩包：tar 里套 zip、rar 里套 zip 这种在网盘资源里非常常见（二次打包）。
 * 解完发现一张图 / 一个视频都没有、却解出了压缩包，就把里面的包再解一层。
 * 最多两层、每层最多取 4 个内层包 —— 挡住「自己包自己」和解压炸弹。
 */
async function expandNested(result, destRoot, depth, password) {
  if (hasMediaFile(result.files) || depth >= NESTED_MAX_DEPTH) return result;
  const inner = result.files.filter((f) => isArchiveName(f.name)).slice(0, NESTED_MAX_INNER);
  if (!inner.length) return result;

  const files = result.files.filter((f) => !inner.includes(f));
  const skipped = [...result.skipped];
  for (const [i, f] of inner.entries()) {
    const sub = path.join(destRoot, `.nested-${depth + 1}-${i}`);
    try {
      const packed = await extractArchive(f.abs, sub, { password, depth: depth + 1 });
      files.push(...packed.files);
      skipped.push(...packed.skipped);
    } catch (err) {
      skipped.push({ name: f.name, reason: err.message || '内层压缩包解压失败' });
      // 内层要密码 / 密码不对：整包失败，让上层去问密码（同一个密码会一起传给内层）
      if (err.code === 'NEED_PASSWORD' || err.code === 'BAD_PASSWORD' || err.code === 'ZIP_AES') {
        const e = new Error(
          err.code === 'NEED_PASSWORD'
            ? '这个包里面又套了一个加密的压缩包，需要输入密码才能解压'
            : err.code === 'BAD_PASSWORD'
              ? '密码不对，内层的压缩包解不开'
              : '这个包里套的是 AES 加密的 zip，站内解不了 —— 用 7-Zip / WinRAR 解开后把文件夹拖进来'
        );
        e.code = err.code;
        throw e;
      }
    }
    // 内层压缩包本身不入库
    await fsp.unlink(f.abs).catch(() => {});
  }
  return { ...result, files, skipped };
}

/**
 * 把压缩包解到 destDir（调用方负责建和清）。
 * 加密包要传 password；没传且确实是加密包时抛 code='NEED_PASSWORD'。
 * 返回 { format, files:[{abs,name,size}], skipped:[{name,reason}], tool }
 */
export async function extractArchive(archiveAbs, destDir, { password = '', depth = 0 } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const st = await fsp.stat(archiveAbs);
  if (!st.size) throw new Error('压缩包是空的');

  const fh = await fsp.open(archiveAbs, 'r');
  let format = null;
  let gzip = false;
  let outerCompressed = false; // bz2 / xz：原生只有 tar 和 gzip，这两个交给外部工具
  let result = null;
  try {
    const head = await readExact(fh, 0, 512);
    format = detectFormat(head, archiveAbs);
    if (!format) throw new Error('认不出这个压缩包（支持 zip / rar / 7z / tar / tar.gz）');
    gzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
    outerCompressed =
      (head.length >= 3 && head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) ||
      (head.length >= 6 && head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])));

    if (format === 'zip') {
      result = await extractZip(fh, st.size, destDir, { password });
    } else if (format === 'tar' && !outerCompressed) {
      try {
        result = await extractTar(archiveAbs, destDir, { gzip });
      } catch (err) {
        console.warn(`[archive] 原生解 tar 失败，退回外部工具：${err.message}`);
        result = null;
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }

  if (!result) {
    const res = await extractWithTool(format, archiveAbs, destDir, password);
    result = {
      format,
      files: res.files.map((abs) => ({ abs, name: path.basename(abs), size: fs.statSync(abs).size })),
      skipped: [],
      tool: res.tool,
    };
  }

  return await expandNested(result, destDir, depth, password);
}
