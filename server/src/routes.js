import express from 'express';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import {
  getDb,
  nowIso,
  mainLibrary,
  defaultShelfId,
  refreshCharacter,
  refreshCharacterSoon,
  refreshPack,
  refreshCharacterPacks,
  ensureSelfTags,
  ensureShelfContainer,
  pruneOrphanTags,
} from './db.js';
import { getDerivative, capturePoster, clearPoster, warmAll, warmState } from './thumbs.js';
import { WEB_DIR, INBOX_DIR, CACHE_DIR, DATA_DIR, slugify } from './config.js';
import {
  absPathOf,
  adoptFile,
  hashFileOf,
  moveFile,
  relocateFile,
  removeLibraryFile,
  removeDir,
  kindOfExt,
  uniqueDirName,
} from './store.js';
import { beginMove, logRecovery } from './file-journal.js';
import { monthOfFileName, monthTitle } from './importer.js';
import { splitTitleTags } from './pack-tags.js';
import { extractArchive, isArchiveName } from './archive.js';
import { syncPackDirs, renamePackDir, pruneDirsOf } from './pack-sync.js';
import { logOp, initialStatus, opsSummary, listOps, archiveOps } from './ops-log.js';
import { applyOps } from './ops-apply.js';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  /* 正文文件：故意不写 charset —— 老网文大量是 GBK，写死 utf-8 会让
     浏览器直接打开时全是乱码。站内阅读器是拿字节流自己判编码的，不受影响。 */
  '.txt': 'text/plain', '.md': 'text/markdown',
  '.epub': 'application/epub+zip', '.pdf': 'application/pdf',
  '.mobi': 'application/x-mobipocket-ebook', '.azw3': 'application/vnd.amazon.ebook',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};


const upload = multer({
  dest: INBOX_DIR,
  limits: { fileSize: 4 * 1024 ** 3, files: 400 },
});

/**
 * 压缩包上传的体检日志：每次尝试记一行，出问题不用再靠猜。
 * 落在 `<CACHE>/archive-log.jsonl`，超过 2 MB 轮转一份 `.1`。
 *
 * v3.69 那次「还是跳过了」查了半天没有现场：请求是 200 还是 400、文件名是什么、
 * 有没有带密码、解出几个文件、入库几个 —— 全靠猜。这里一次记全。
 */
function logArchiveAttempt(entry) {
  try {
    const file = path.join(CACHE_DIR, 'archive-log.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`);
  } catch {
    /* 记日志失败不能影响上传本身 */
  }
}

function decodeName(n) {
  try {
    const utf8 = Buffer.from(String(n), 'latin1').toString('utf8');
    return utf8.includes('\uFFFD') ? String(n) : utf8;
  } catch {
    return String(n);
  }
}

function tagsOf(db, charId) {
  return db
    .prepare(`SELECT t.name FROM tags t JOIN character_tags ct ON ct.tag_id = t.id WHERE ct.character_id = ? ORDER BY t.name`)
    .all(charId)
    .map((r) => r.name);
}

/** 标签清洗：去空白、去重、限长、最多 30 个 */
/**
 * 图包标签里始终保留一条「和图包同名」的。
 *
 * 包内媒体会继承图包标签（v3.15），所以名字能对上，按标签就能把整包取出来；
 * 改名时把旧名字那条换掉，用户自己加的标签一律保留。
 */
function packTagsKeepingName(tags, oldTitle, newTitle) {
  const before = splitTitleTags(oldTitle);
  const after = splitTitleTags(newTitle);
  // 「名字拆出来的标签」才归自动逻辑管：用户手动加的同名标签也一起换（本来就是同一个意思）
  const drop = new Set([String(oldTitle || '').trim(), ...before.filter((t) => !after.includes(t))]);
  const keep = (Array.isArray(tags) ? tags : []).filter((t) => !drop.has(String(t || '')));
  return cleanTags([...keep, ...after]);
}

function cleanTags(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const n = String(raw || '').trim().slice(0, 40);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 30) break;
  }
  return out;
}

/** 去重合并若干标签数组 */
function mergeTags(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const raw of list || []) {
      const n = String(raw || '').trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * 媒体继承的标签 = 条目名。
 *
 * - 库类型（人物 / 角色 / 小说）**不下发**：它只是当前页面的身份，放在每张图的标签里
 *   既是噪音，又会在标签池里造出三条几千次计数、点进去毫无意义的假标签。
 * - 条目上手动加的通用标签（原神、米哈游、写真…）也不下发：一个人物可能只有一两个
 *   图包跟某个作品有关，全量下发会把上千张图一起染色。要标就给图包标 / 给单张图标。
 */
function mediaTagSet(db, charId) {
  const c = db
    .prepare(`SELECT c.name, c.is_container, sh.kind FROM characters c LEFT JOIN shelves sh ON sh.id = c.shelf_id WHERE c.id = ?`)
    .get(charId);
  if (!c) return [];
  if (c.is_container || c.kind === 'emoji') return [];
  return mergeTags([c.name]);
}

/** 当前月份 'YYYY-MM'（散图集里没有日期的文件按入库月份归包，别用「未分类」这个名） */
function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 图包标签 = 名字拆出来的 + **所属条目名**。
 *
 * 包挂在谁名下就带上谁的名字，这样在标签池里搜「水淼」能一次看到她的所有图包，
 * 点标签也能落到标签页。容器条目（表情包 / 收件箱 / 小说库的书袋）没有这层含义，跳过。
 */
function ownerTagOf(db, charId) {
  if (!charId) return '';
  const c = db.prepare('SELECT name, is_container FROM characters WHERE id = ?').get(Number(charId));
  if (!c || c.is_container) return '';
  return String(c.name || '').trim();
}

function packTagsFor(db, charId, title) {
  return cleanTags([...splitTitleTags(title), ownerTagOf(db, charId)]);
}

/** 用户手动改标签时也别把「所属条目名」那条弄丢 */
function withOwnerTag(db, charId, tags) {
  return cleanTags([...(Array.isArray(tags) ? tags : []), ownerTagOf(db, charId)]);
}

/** 图包标签：所有库都会下发给包内每张图，标一次全包生效（读时合并，不落库） */
function packTagMap(db, charId) {
  const map = new Map();
  for (const r of db.prepare('SELECT id, tags FROM packs WHERE character_id = ?').all(charId)) {
    map.set(r.id, safeJson(r.tags));
  }
  return map;
}

/** 别名：简称 / 日文名 / 英文名。去空、去重、限长，最多 20 条 */
function cleanAliases(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const t = String(x || '').trim().slice(0, 60);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 同一个库里有没有同名条目（隐藏容器不算 —— 收件箱 / 表情包那个壳的名字是占位的）。
 *
 * 新建与改名都走这里。`excludeId` 给改名用：不能把自己算成重名。
 *
 * v3.65 之前只有小说库查这一条，人物 / 角色集任由重名建下去：界面里两个一模一样
 * 的名字，磁盘上两个目录（第二个被 `uniqueDirName()` 改成「名字-2」），用户分不清
 * 哪个是哪个，素材也会散在两边。
 */
function sameNameChar(db, shelfId, name, excludeId = 0) {
  return db
    .prepare('SELECT id, dir_slug FROM characters WHERE shelf_id = ? AND is_container = 0 AND name = ? AND id <> ?')
    .get(shelfId, name, excludeId);
}

function mapChar(row, tags) {
  return {
    id: row.id,
    shelfId: row.shelf_id,
    name: row.name,
    account: row.account,
    category: row.category || '',
    // 小说库（其他库这几个字段为空）
    novelGroup: row.novel_group || '',
    novelSubtype: row.novel_subtype || '',
    author: row.author || '',
    wordCount: row.word_count || 0,
    novelStatus: row.novel_status || '',
    intro: row.intro,
    dirSlug: row.dir_slug,
    coverMediaId: row.cover_media_id,
    mediaCount: row.media_count ?? 0,
    packCount: row.pack_count ?? 0,
    bytes: row.total_bytes ?? 0,
    tags: tags || [],
    platforms: safeJson(row.platforms),
    aliases: safeJson(row.aliases),
    shelf: {
      id: row.shelf_id,
      name: row.shelf_name || '',
      kind: row.shelf_kind || 'people',
      // 小说库才有：original 原创 / fanfic 同人
      variant: row.shelf_variant || '',
    },
  };
}

function safeJson(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 库的类型：
 * people 真人（有社交账号）/ work 虚拟角色（标注出处）
 * emoji 表情包（没有条目层级，库里直接是图包 + 未分类 + 全部素材）
 * resource 作品录（游戏 / 动画 / 电影 / 剧集，卡片按分类分组）
 * novel 小说库（条目=一本小说，novel_group 是磁盘上的归类文件夹）
 * inbox 收件箱（没有条目层级：未分发=落在 <库名>/未分类 里的，已分发=全库其余媒体，只链接不复制）
 */
function normalizeShelfKind(v) {
  const k = String(v || '').toLowerCase();
  if (k === 'work') return 'work';
  if (k === 'emoji') return 'emoji';
  // 散图集：扁平库，只有「图包 / 全部素材」，没有条目也没有未分类入口
  if (k === 'loose') return 'loose';
  if (k === 'resource') return 'resource';
  if (k === 'novel') return 'novel';
  if (k === 'inbox') return 'inbox';
  return 'people';
}

/**
 * 小说库的两个分支。分类视图（tab）的值域由它决定，且**只做筛选、不落磁盘**：
 * 出版 / 网络、短篇 / 长篇是一本书的单一属性，做成文件夹会把同一类型劈成两半。
 */
const NOVEL_VIEWS = {
  original: ['出版', '网络'],
  fanfic: ['短篇', '长篇'],
};

function normalizeVariant(v) {
  return String(v || '').toLowerCase() === 'fanfic' ? 'fanfic' : 'original';
}

/** 小说库视图值域；非小说库返回空数组 */
function novelViewsOf(shelf) {
  if (!shelf || shelf.kind !== 'novel') return [];
  return NOVEL_VIEWS[normalizeVariant(shelf.variant)] || NOVEL_VIEWS.original;
}

/** 只收本库值域内的值，其余一律丢弃（避免脏值让书在所有 tab 里都不出现） */
function pickNovelSubtype(shelf, v) {
  const s = String(v || '').trim();
  return novelViewsOf(shelf).includes(s) ? s : null;
}

/** 平台主页网址：只收 http/https；没写协议就补 https；非法值直接丢弃 */
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname || !u.hostname.includes('.')) return '';
    return u.toString().slice(0, 300);
  } catch {
    return '';
  }
}

const CHAR_SELECT = `
  SELECT c.*, sh.name AS shelf_name, sh.kind AS shelf_kind, sh.variant AS shelf_variant,
    (SELECT COUNT(*) FROM media m WHERE m.character_id = c.id) AS media_count,
    (SELECT COUNT(*) FROM packs p WHERE p.character_id = c.id) AS pack_count,
    (SELECT COALESCE(SUM(m.bytes),0) FROM media m WHERE m.character_id = c.id) AS total_bytes
  FROM characters c LEFT JOIN shelves sh ON sh.id = c.shelf_id`;

function mapMedia(r) {
  const own = safeJson(r.tags);
  return {
    id: r.id,
    packId: r.pack_id,
    kind: r.kind,
    // 库里存的是带点的 .gif，前端只认 gif
    ext: String(r.ext || '').toLowerCase().replace(/^\./, ''),
    fileName: r.file_name,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    bytes: r.bytes,
    // 真动图：按帧数标记（视频也算），gif 扩展名不算
    anim: r.kind === 'video' ? true : !!r.anim,
    // 视频自定义封面抽的是第几毫秒；null = 用自动首帧
    posterMs: r.poster_ms ?? null,
    sortOrder: r.sort_order,
    // 漫画页序（只有漫画包有值）；和图包排序 sort_order 完全独立
    pageNo: r.page_no ?? null,
    // 入库时间：图包内「按时间排序」的兜底键（文件名里有日期时优先用文件名）
    createdAt: r.created_at,
    tags: own,
    // 自己手动打的标签；tags 会被调用方替换成「含继承」的完整集合
    ownTags: own,
  };
}

/** 文件名自然序：1、2、10 按数字大小排 —— 漫画页序就靠它，别用字符串序 */
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

/** 上传后按文件名月份自动归包；没有日期的进「未分类」 */
function ensurePackFor(db, charId, month, category = null) {
  const existing = db
    .prepare('SELECT id, title FROM packs WHERE character_id = ? AND month IS ? AND category IS ?')
    .get(charId, month, category);
  if (existing) return { id: existing.id, title: existing.title };
  const title = monthTitle(month);
  const id = Number(
    db
      .prepare(
        `INSERT INTO packs(character_id, title, month, category, tags, sort_order, created_at)
         VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
      )
      .run(charId, title, month, category, JSON.stringify(packTagsFor(db, charId, title)), charId, nowIso()).lastInsertRowid
  );
  return { id, title };
}

/**
 * 按名字取图包：已有同名包直接复用，没有才新建。
 * 压缩包拖到条目首页时用它 —— 反复拖同一个包不该长出一堆重名图包。
 */
function ensureNamedPack(db, charId, rawTitle, category = null) {
  const title = String(rawTitle || '').trim().slice(0, 100) || '未命名';
  const dup = db
    .prepare('SELECT id, title FROM packs WHERE character_id = ? AND title = ? ORDER BY id LIMIT 1')
    .get(charId, title);
  if (dup) return { id: dup.id, title: dup.title, created: false };
  const id = Number(
    db
      .prepare(
        `INSERT INTO packs(character_id, title, month, category, tags, sort_order, created_at)
         VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
      )
      .run(charId, title, null, category, JSON.stringify(packTagsFor(db, charId, title)), charId, nowIso()).lastInsertRowid
  );
  return { id, title, created: true };
}

/** 「卡芙卡-泳装.part1.rar」「xxx.7z.001」→「卡芙卡-泳装」：去掉压缩包后缀当图包名 */
function titleFromArchive(name) {
  let s = String(name || '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s
      .replace(/\.(zip|rar|7z|tar|tgz|gz|bz2|xz|zst)$/i, '')
      .replace(/\.part\d+$/i, '')
      .replace(/\.\d{3}$/i, '') // 7z 分卷 .001
      .trim();
    if (next === s) break;
    s = next;
  }
  return s || '压缩包';
}

/**
 * 算出文件该落在哪个目录：<角色集>/<角色>/<图包>/<图片|视频>
 * 图包目录沿用库里已有文件的位置；新图包才新建目录，避免重复生成 -2 -3
 */
async function resolvePackDir(db, charRelDir, pack, kind, category = null) {
  const typeDir = kind === 'image' ? '图片' : '视频';
  const existing = db.prepare('SELECT rel_path FROM media WHERE pack_id = ? LIMIT 1').get(pack.id);
  if (existing) {
    const parts = existing.rel_path.split('/');
    return [...parts.slice(0, -2), typeDir].join('/');
  }
  // 虚拟角色集：库/角色/小库/图包/图片|视频
  const base = category ? `${charRelDir}/${category}` : charRelDir;
  // 图包被搬空但目录还在时沿用旧目录，否则每搬一次就分裂出「-2」「-3」
  const plain = slugify(pack.title);
  if (fs.existsSync(absPathOf(`${base}/${plain}`))) {
    return `${base}/${plain}/${typeDir}`;
  }
  const slug = await uniqueDirName(base, pack.title);
  return `${base}/${slug}/${typeDir}`;
}

/**
 * 新建角色的目录：<角色集>/<角色>
 * 角色集那一段必须复用已有角色用过的名字，不能每次 slugify 一遍，
 * 否则同一个库会裂成「角色集」「角色集-2」。
 */
/** 库在磁盘上的目录名：优先复用已有条目用过的前缀，避免同一个库裂成「角色集」「角色集-2」 */
function shelfSlugOf(db, shelfId) {
  const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
  const sample = db
    .prepare(`SELECT dir_slug FROM characters WHERE shelf_id = ? AND dir_slug LIKE '%/%' LIMIT 1`)
    .get(shelfId);
  return sample ? sample.dir_slug.split('/')[0] : slugify(shelf ? shelf.name : '角色集');
}

/**
 * 新建条目的目录：<库>/<条目>，小说库多一层归类文件夹 <库>/<novel_group>/<书名>。
 * group 为空时退回两级，其他库的行为完全不变。
 */
async function uniqueCharRelDir(db, shelfId, name, group = '') {
  const shelfSlug = shelfSlugOf(db, shelfId);
  const g = String(group || '').trim();
  const parent = g ? `${shelfSlug}/${slugify(g)}` : shelfSlug;
  const charSlug = await uniqueDirName(parent, name);
  return g ? `${parent}/${charSlug}` : `${shelfSlug}/${charSlug}`;
}

async function mkdirRel(relDir) {
  if (!relDir) return;
  try {
    await fsp.mkdir(absPathOf(relDir), { recursive: true });
  } catch {
    /* 权限 / 占用之类的问题留给第一次上传时重试 */
  }
}

/**
 * Windows 上重命名目录会遇到 EPERM：目录里只要还有一个文件被别的进程打开
 * （缩略图生成、系统索引、杀软扫描、刚返回的 /m/:id 响应），整个目录就锁着。
 * 先短暂重试，仍不行就降级成「整目录复制 + 删源」，别让一次改名直接失败。
 */
async function renameDirWithRetry(src, dst, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      await fsp.rename(src, dst);
      return true;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  try {
    await fsp.cp(src, dst, { recursive: true, force: true });
    await fsp.rm(src, { recursive: true, force: true });
    return true;
  } catch {
    await fsp.rm(dst, { recursive: true, force: true }).catch(() => {});
    const err = new Error(`目录被占用，无法重命名。请关闭正在使用该目录的程序后重试`);
    err.status = 423;
    err.cause = lastErr;
    throw err;
  }
}

/**
 * 小说库改书名 / 改归类文件夹时搬磁盘目录。
 *
 * 目录名就是归类层，DB 改了不动目录会立刻「界面一套、磁盘一套」。
 * 只负责搬目录，DB 的 dir_slug / media.rel_path 由调用方在事务里一起改；
 * 事务失败要把目录搬回来（返回的 moved 告诉调用方有没有真的动过）。
 */
async function moveNovelDir(db, row, targetRel) {
  const oldRel = String(row.dir_slug || '');
  if (!oldRel || oldRel === targetRel) return { moved: false, oldRel };

  const oldAbs = absPathOf(oldRel);
  const targetAbs = absPathOf(targetRel);
  if (fs.existsSync(targetAbs)) {
    const err = new Error(`目标目录已存在：${targetRel}`);
    err.status = 409;
    throw err;
  }

  const parentRel = targetRel.split('/').slice(0, -1).join('/');
  await mkdirRel(parentRel);

  const hasOld = fs.existsSync(oldAbs);
  if (hasOld) await renameDirWithRetry(oldAbs, targetAbs);
  return { moved: hasOld, oldRel, oldAbs, targetAbs };
}

/**
 * 新建条目时就把目录建出来，连「未分类/图片、未分类/视频」两个标准子目录一起建。
 *
 * 以前只在第一次上传时才 mkdir，结果前端建完人物、磁盘上什么都没有，
 * 「打开本地文件夹」还会报目录已丢失。建目录失败不拦建条目（上传时会再建一次）。
 */
async function ensureCharDirs(relDir, novel = false) {
  if (!relDir) return;
  await mkdirRel(relDir);
  // 小说库放的是正文文件 + 可能的插图，不建「视频」（空目录只是噪音）
  if (novel) {
    await mkdirRel(`${relDir}/未分类/文件`);
    await mkdirRel(`${relDir}/未分类/图片`);
    return;
  }
  await mkdirRel(`${relDir}/未分类/图片`);
  await mkdirRel(`${relDir}/未分类/视频`);
}

const OFFICIAL_PACK = '官方';

/**
 * 书的归类保存后，确保库里有一个同名书袋。
 * 书袋和书靠 characters.novel_group（= 书袋名）关联，这里是唯一的「按需建袋」入口。
 */
function ensureNovelBag(db, shelfId, title) {
  const t = String(title || '').trim();
  if (!t || !shelfId) return null;
  const container = ensureShelfContainer(shelfId);
  if (!container) return null;
  const exists = db
    .prepare("SELECT id FROM packs WHERE character_id = ? AND kind = 'novel' AND title = ?")
    .get(container.id, t);
  if (exists) return exists.id;
  return Number(
    db
      .prepare(
        `INSERT INTO packs(character_id, title, month, category, kind, tags, sort_order, created_at)
         VALUES(?,?,NULL,NULL,'novel',?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
      )
      .run(container.id, t, JSON.stringify([t]), container.id, nowIso()).lastInsertRowid
  );
}

/**
 * 作品录的每个「作品」预置一个「官方」图包：
 * `<作品录>/<作品>/官方/图片|视频`，和其他库「条目/图包/图片|视频」的层级完全一致。
 * 资源本身不直接存媒体，这里只建空壳（DB 一条 pack + 两个子目录），
 * 官方图可以直接往里放，也能被图包页 / 上传接口按常规流程用起来。
 */
async function ensureOfficialPack(db, charId, dirSlug) {
  if (!charId || !dirSlug) return null;
  let pack = db
    .prepare('SELECT id FROM packs WHERE character_id = ? AND title = ? AND month IS NULL')
    .get(charId, OFFICIAL_PACK);
  if (!pack) {
    const id = Number(
      db
        .prepare(
          `INSERT INTO packs(character_id, title, month, category, sort_order, created_at, tags)
           VALUES(?,?,NULL,NULL,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?,?)`
        )
        .run(charId, OFFICIAL_PACK, charId, nowIso(), JSON.stringify(packTagsFor(db, charId, OFFICIAL_PACK))).lastInsertRowid
    );
    pack = { id };
  }
  await mkdirRel(`${dirSlug}/${OFFICIAL_PACK}/图片`);
  await mkdirRel(`${dirSlug}/${OFFICIAL_PACK}/视频`);
  return pack.id;
}

/**
 * 资源版本号 = web 目录下最新文件的 mtime。
 * 改完前端不重启服务也会自动换版本，浏览器不可能命中旧缓存。
 */
let verCache = { value: '0', at: 0 };
function assetVersion() {
  const now = Date.now();
  if (now - verCache.at < 1500) return verCache.value;
  let max = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          max = Math.max(max, fs.statSync(p).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(WEB_DIR);
  verCache = { value: Math.round(max).toString(36), at: now };
  return verCache.value;
}

function serveIndex(req, res) {
  let html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const v = assetVersion();
  // 用路径前缀而不是 query：ESM 的相对 import 会自动继承前缀，
  // 否则 main.js 带版本、它 import 的 api.js 不带，就会出现新旧模块混搭
  html = html.replace(/(src|href)="\/(css|js)\/([^"]+)"/g, (m, attr, dir, file) => `${attr}="/a/${v}/${dir}/${file}"`);
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(html);
}

/** 删除失败时拼一句人话：错误码 + 原因，方便用户判断是占用还是权限 */
function whyDeleteFailed(r) {
  return `${r.error || '删除失败'}${r.code ? `（${r.code}）` : ''}`;
}

/**
 * 删完目录但没删干净的兜底：记一条可追溯的记录，并把路径回给调用方。
 * 不自动重试、更不自动删「疑似残留」的目录 —— 归属没确认的东西一律不碰。
 */
async function noteDirLeftover(relDir, r) {
  await logRecovery({
    kind: 'dir-remove-failed',
    relDir,
    code: r.code || null,
    error: r.error || null,
    remaining: r.remaining ?? null,
    path: r.path || null,
  });
  return `目录没能完全删除：${whyDeleteFailed(r)}${r.remaining != null ? `，还剩 ${r.remaining} 个文件` : ''}`;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // 必须在 static 之前：首页由服务端注入版本号
  app.get('/', serveIndex);
  app.get('/index.html', serveIndex);

  // 带版本前缀的静态资源：/a/<ver>/js/api.js → web/js/api.js
  app.use((req, res, next) => {
    const m = /^\/a\/([A-Za-z0-9]+)\/(.+)$/.exec(req.path);
    if (!m) return next();
    const [, ver, rest] = m;
    const abs = path.join(WEB_DIR, decodeURIComponent(rest));
    const rel = path.relative(WEB_DIR, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return res.status(400).end();
    // 版本对得上就长缓存；对不上说明页面是旧的，仍给最新内容但禁止缓存
    res.setHeader(
      'Cache-Control',
      ver === assetVersion() ? 'public, max-age=31536000, immutable' : 'no-cache'
    );
    res.sendFile(abs, { dotfiles: 'ignore' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.get('/api/overview', (req, res) => {
    const db = getDb();
    const lib = mainLibrary();
    const shelves = db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM characters c WHERE c.shelf_id = s.id AND c.is_container = 0) AS character_count,
           (SELECT COUNT(*) FROM media m JOIN characters c ON c.id = m.character_id WHERE c.shelf_id = s.id) AS media_count,
           (SELECT COUNT(*) FROM packs p JOIN characters c ON c.id = p.character_id WHERE c.shelf_id = s.id) AS pack_count,
           (SELECT COUNT(*) FROM media m JOIN characters c ON c.id = m.character_id
              WHERE c.shelf_id = s.id AND (m.anim = 1 OR m.kind = 'video')) AS anim_count,
           (SELECT COALESCE(SUM(m.bytes),0) FROM media m JOIN characters c ON c.id = m.character_id WHERE c.shelf_id = s.id) AS bytes,
           (SELECT m.id FROM media m JOIN characters c ON c.id = m.character_id
              WHERE c.shelf_id = s.id AND m.kind IN ('image','video')
              ORDER BY CASE m.kind WHEN 'image' THEN 0 ELSE 1 END, m.id LIMIT 1) AS cover_media_id
         FROM shelves s WHERE s.library_id = ? ORDER BY s.sort_order, s.id`
      )
      .all(lib.id);
    const totals = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM characters WHERE is_container = 0) characters,
           (SELECT COUNT(*) FROM media) media,
           (SELECT COUNT(*) FROM packs) packs,
           (SELECT COALESCE(SUM(bytes),0) FROM media) bytes`
      )
      .get();
    res.json({
      library: { id: lib.id, name: lib.name, rootPath: lib.root_path },
      shelves: shelves.map((s) => ({
        id: s.id,
        name: s.name,
        note: s.note,
        kind: s.kind || 'people',
        variant: s.variant || '',
        characterCount: s.character_count,
        packCount: s.pack_count,
        mediaCount: s.media_count,
        animCount: s.anim_count,
        bytes: s.bytes,
        coverMediaId: s.cover_media_id,
      })),
      totals,
    });
  });

  // ---------- 角色集 ----------
  app.post('/api/shelves', async (req, res) => {
    const db = getDb();
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: '角色集名称不能为空' });
    const lib = mainLibrary();
    const kind = normalizeShelfKind(req.body.kind);
    // variant 只有小说库有：原创书 / 同人书
    const variant = kind === 'novel' ? normalizeVariant(req.body.variant) : null;
    const id = Number(
      db
        .prepare(
          `INSERT INTO shelves(library_id, name, note, kind, variant, sort_order, created_at, updated_at)
           VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM shelves WHERE library_id=?),?,?)`
        )
        .run(
          lib.id,
          name.slice(0, 60),
          String(req.body.note || '').slice(0, 500),
          kind,
          variant,
          lib.id,
          nowIso(),
          nowIso()
        )
        .lastInsertRowid
    );
    // 表情包 / 散图集 / 收件箱都没有条目层级，靠一个隐藏容器条目挂图包（和未分类）
    if (kind === 'emoji' || kind === 'loose' || kind === 'inbox') ensureShelfContainer(id);
    // 库根目录建出来：否则资源管理器里少一个库，用户会以为数据没落盘
    await mkdirRel(shelfSlugOf(db, id));
    res.json({ id, name, kind, variant });
  });

  app.patch('/api/shelves/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const { name, note, kind, variant } = req.body || {};
    const row = db.prepare('SELECT * FROM shelves WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '库不存在' });
    const nextKind = kind === undefined ? row.kind : normalizeShelfKind(kind);
    const nextVariant =
      nextKind === 'novel'
        ? variant === undefined
          ? normalizeVariant(row.variant)
          : normalizeVariant(variant)
        : null;
    db.prepare('UPDATE shelves SET name = ?, note = ?, kind = ?, variant = ?, updated_at = ? WHERE id = ?').run(
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : row.name,
      typeof note === 'string' ? note.slice(0, 500) : row.note,
      nextKind,
      nextVariant,
      nowIso(),
      id
    );
    // 改成表情包 / 散图集 / 收件箱时补一个容器条目，否则前端没有地方挂图包
    if (nextKind === 'emoji' || nextKind === 'loose' || nextKind === 'inbox') ensureShelfContainer(id);
    res.json({ ok: true, kind: nextKind, variant: nextVariant });
  });

  app.delete('/api/shelves/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const n = db.prepare('SELECT COUNT(*) n FROM characters WHERE shelf_id = ? AND is_container = 0').get(id).n;
    if (n > 0) return res.status(400).json({ error: `该库下还有 ${n} 个条目，请先移走或删除` });
    const media = db
      .prepare('SELECT COUNT(*) n FROM media m JOIN characters c ON c.id = m.character_id WHERE c.shelf_id = ?')
      .get(id).n;
    if (media > 0) return res.status(400).json({ error: `该库下还有 ${media} 个媒体，请先清空` });
    const slug = shelfSlugOf(db, id); // 删之前算，删完就查不到 shelf 了
    db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
    // 只删空目录：非递归 rmdir 撞到用户自己的文件会抛错，正好保留下来
    try {
      fs.rmdirSync(absPathOf(slug));
    } catch {
      /* 非空 / 不存在都留着 */
    }
    res.json({ ok: true });
  });

  // 在资源管理器里打开（媒体=选中文件，图包/角色=打开目录）
  app.post('/api/reveal', (req, res) => {
    const db = getDb();
    const { kind, id } = req.body || {};
    const numId = Number(id);
    let target = null;
    if (kind === 'media') {
      const row = db.prepare('SELECT rel_path FROM media WHERE id = ?').get(numId);
      if (row) target = absPathOf(row.rel_path);
    } else if (kind === 'pack') {
      const first = db.prepare('SELECT rel_path FROM media WHERE pack_id = ? LIMIT 1').get(numId);
      if (first) {
        // <条目>/<图包>/<图片|视频>/<文件> 往上两级才是图包根目录
        target = path.dirname(path.dirname(absPathOf(first.rel_path)));
      } else {
        const row = db
          .prepare('SELECT c.dir_slug FROM packs p JOIN characters c ON c.id = p.character_id WHERE p.id = ?')
          .get(numId);
        if (row) target = absPathOf(row.dir_slug);
      }
    } else if (kind === 'character') {
      const row = db.prepare('SELECT dir_slug FROM characters WHERE id = ?').get(numId);
      if (row) target = absPathOf(row.dir_slug);
    }
    if (!target) return res.status(404).json({ error: '找不到对应的磁盘路径' });

    const root = path.resolve(DATA_DIR);
    const abs = path.resolve(target);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return res.status(400).json({ error: '路径越界' });
    }
    try {
      // 条目目录可能还没建（作品录的卡片本身不存媒体，不做预热 mkdir），
      // 用户点「打开本地文件夹」时补一个，比报「目录已丢失」合理
      if (kind === 'character' && !fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
      const isDir = fs.statSync(abs).isDirectory();
      // 引号只能加在路径本身外面，也就是 /select,"路径" 这种形态；
      // 交给 Node 自动加引号会变成 "/select,路径"，explorer 解析不了
      const arg = isDir ? `"${abs}"` : `/select,"${abs}"`;
      spawn('explorer.exe', [arg], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
      res.json({ ok: true, path: abs });
    } catch {
      res.status(404).json({ error: '文件已丢失', path: abs });
    }
  });

  // 全部标签 + 每个标签被多少条目使用
  app.get('/api/tags', (req, res) => {
    const db = getDb();
    const pool = new Map();
    const bump = (name, n) => pool.set(name, (pool.get(name) || 0) + n);
    for (const r of db
      .prepare(
        `SELECT t.name, COUNT(ct.character_id) AS c
         FROM tags t LEFT JOIN character_tags ct ON ct.tag_id = t.id
         GROUP BY t.id`
      )
      .all()) {
      bump(r.name, r.c);
    }
    for (const r of db.prepare('SELECT tags FROM packs').all()) {
      for (const n of safeJson(r.tags)) bump(n, 1);
    }
    for (const r of db.prepare('SELECT tags FROM media WHERE tags <> ?').all('[]')) {
      for (const n of safeJson(r.tags)) bump(n, 1);
    }
    const items = [...pool.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
    res.json({ items });
  });

  /**
   * 单个标签的落地页：条目 / 图包 / 素材三段。
   *
   * 素材口径和「标签是怎么算出来的」保持一致：
   * 自己的标签里有它、所属条目名等于它、或者所在图包有这个标签。
   * 图包口径只认 packs.tags（包继承了条目名标签，所以搜条目名也能列出它的包）。
   */
  app.get('/api/tags/:name', (req, res) => {
    const db = getDb();
    const name = String(req.params.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: '缺少标签名' });

    const charRows = db
      .prepare(
        `${CHAR_SELECT}
          WHERE c.is_container = 0
            AND (c.name = @name
              OR EXISTS (SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
                          WHERE ct.character_id = c.id AND t.name = @name))
          ORDER BY c.name
          LIMIT 200`
      )
      .all({ name });

    const packs = db
      .prepare(
        `SELECT p.id, p.title, p.kind, p.cover_media_id, p.month, p.created_at, p.tags,
                c.id AS owner_id, c.name AS owner_name,
                sh.name AS shelf_name, sh.kind AS shelf_kind,
                (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND m.kind <> 'file') AS media_count,
                (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND m.kind = 'image') AS image_count,
                (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND m.kind = 'video') AS video_count
           FROM packs p
           JOIN characters c ON c.id = p.character_id
           LEFT JOIN shelves sh ON sh.id = c.shelf_id
          WHERE EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = @name)
          ORDER BY p.id DESC
          LIMIT 300`
      )
      .all({ name });

    const whereMedia = `m.kind <> 'file' AND (
        EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = @name)
        OR c.name = @name
        OR EXISTS (SELECT 1 FROM packs p WHERE p.id = m.pack_id
                    AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = @name))
      )`;
    const mediaTotal = db
      .prepare(`SELECT COUNT(*) AS n FROM media m LEFT JOIN characters c ON c.id = m.character_id WHERE ${whereMedia}`)
      .get({ name }).n;
    const mediaRows = db
      .prepare(
        `SELECT m.* FROM media m LEFT JOIN characters c ON c.id = m.character_id
          WHERE ${whereMedia} ORDER BY m.id DESC LIMIT 200`
      )
      .all({ name });

    res.json({
      name,
      characters: charRows.map((r) => mapChar(r, tagsOf(db, r.id))),
      packs: packs.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind || 'pack',
        month: r.month,
        createdAt: r.created_at,
        coverMediaId: r.cover_media_id,
        tags: safeJson(r.tags),
        mediaCount: r.media_count,
        imageCount: r.image_count,
        videoCount: r.video_count,
        owner: { id: r.owner_id, name: r.owner_name },
        shelf: { name: r.shelf_name || '', kind: r.shelf_kind || 'people' },
      })),
      media: mediaRows.map(mapMedia),
      counts: { characters: charRows.length, packs: packs.length, media: mediaTotal },
    });
  });

  // ---------- 角色 ----------
  app.get('/api/shelves/:id/characters', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const q = String(req.query.q || '').trim();
    const sort = String(req.query.sort || 'media');
    const where = ['c.shelf_id = @shelfId', 'c.is_container = 0'];
    const params = { shelfId };
    if (q) {
      // 标签也算：人物集/角色集里搜「原神」应该把打了这个标签的条目都找出来，
      // 而不是只有名字里带「原神」的那几个
      where.push(`(c.name LIKE @q OR c.account LIKE @q OR c.author LIKE @q OR c.aliases LIKE @q
        OR EXISTS (SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
                   WHERE ct.character_id = c.id AND t.name LIKE @q))`);
      params.q = `%${q}%`;
    }
    const order =
      sort === 'name' ? 'ORDER BY c.name COLLATE NOCASE'
      : sort === 'packs' ? 'ORDER BY pack_count DESC, media_count DESC, c.id DESC'
      : sort === 'recent' ? 'ORDER BY c.updated_at DESC, c.id DESC'
      : 'ORDER BY media_count DESC, pack_count DESC, c.id DESC';
    const rows = db
      .prepare(`${CHAR_SELECT} WHERE ${where.join(' AND ')} ${order}`)
      .all(params);
    res.json({ items: rows.map((r) => mapChar(r, tagsOf(db, r.id))), total: rows.length });
  });

  /**
   * 小说库首页：分类视图（tab）+ 归类文件夹（分组）+ 书卡列表。
   *
   * 两个维度是正交的，别混：
   *   view  = novel_subtype（出版/网络 或 短篇/长篇），只筛选，不落磁盘
   *   group = novel_group（小说类型 或 原作品名），既是分组标题也是磁盘上的一层目录
   * 所以 view 只影响「这页显示哪些书」，group 影响「书放在哪个文件夹」。
   */
  /**
   * 小说库的「书袋」：把不同的类型 / 原作实体化成一条 pack（kind='novel'）。
   * 书和书袋的关系仍用 characters.novel_group（= 书袋名），书袋挂在库的容器条目下。
   */
  /**
   * 跨库「关联图包」：别的库里那些标签里带着这个条目名的图包。
   *
   * 只是入口，不复制不移动 —— 图包仍然留在原来的库里，点进去还是 /p/:id。
   * 匹配用**标签精确等于条目名**，不做模糊：图包叫「卡芙卡-泳装」、标签加「卡芙卡」「泳装」，
   * 就会被卡芙卡收进来；只叫「卡芙卡泳装」而标签也只有一个整串的，不会误归。
   */
  app.get('/api/characters/:id/linked-packs', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const c = db.prepare('SELECT id, name FROM characters WHERE id = ?').get(id);
    if (!c) return res.status(404).json({ error: '条目不存在' });
    const name = String(c.name || '').trim();
    if (!name) return res.json({ items: [] });

    const rows = db
      .prepare(
        `SELECT p.*, ch.name AS owner_name, sh.name AS shelf_name, sh.kind AS shelf_kind,
                (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id) AS media_count
           FROM packs p
           JOIN characters ch ON ch.id = p.character_id
           LEFT JOIN shelves sh ON sh.id = ch.shelf_id
          WHERE p.character_id <> @id
            AND COALESCE(p.kind, 'pack') = 'pack'
            AND EXISTS (SELECT 1 FROM json_each(p.tags) t WHERE t.value = @name)
          ORDER BY p.created_at DESC`
      )
      .all({ id, name });

    res.json({
      items: rows.map((p) => ({
        id: p.id,
        title: p.title,
        category: p.category || '',
        month: p.month,
        tags: safeJson(p.tags),
        mediaCount: p.media_count || 0,
        coverMediaId: p.cover_media_id || null,
        owner: { id: p.character_id, name: p.owner_name },
        shelf: { name: p.shelf_name || '', kind: p.shelf_kind || '' },
      })),
    });
  });

  app.get('/api/shelves/:id/novelbags', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(404).json({ error: '库不存在' });
    if (shelf.kind !== 'novel') return res.status(400).json({ error: '不是小说库' });
    const container = ensureShelfContainer(shelfId);
    if (!container) return res.status(404).json({ error: '小说库没有准备好' });

    const rows = db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM characters c
                  WHERE c.shelf_id = @shelfId AND c.is_container = 0
                    AND COALESCE(c.novel_group,'') = CASE WHEN p.title = '未分类' THEN '' ELSE p.title END) AS book_count,
                (SELECT c.cover_media_id FROM characters c
                  WHERE c.shelf_id = @shelfId AND c.is_container = 0 AND c.cover_media_id IS NOT NULL
                    AND COALESCE(c.novel_group,'') = CASE WHEN p.title = '未分类' THEN '' ELSE p.title END
                  LIMIT 1) AS bag_cover
           FROM packs p
          WHERE p.character_id = @containerId AND p.kind = 'novel'
          ORDER BY p.sort_order, p.id`
      )
      .all({ shelfId, containerId: container.id });

    res.json({
      shelf: { id: shelf.id, name: shelf.name, variant: shelf.variant || '' },
      items: rows.map((p) => ({
        id: p.id,
        title: p.title,
        tags: safeJson(p.tags),
        bookCount: p.book_count || 0,
        // 书袋自己的封面优先，没有就用组里第一本书的
        coverMediaId: p.cover_media_id || p.bag_cover || null,
        createdAt: p.created_at,
      })),
    });
  });

  app.post('/api/shelves/:id/novelbags', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(404).json({ error: '库不存在' });
    if (shelf.kind !== 'novel') return res.status(400).json({ error: '不是小说库' });
    const title = String((req.body && req.body.title) || '').trim().slice(0, 40);
    if (!title) return res.status(400).json({ error: '书袋名称不能为空' });
    const container = ensureShelfContainer(shelfId);
    if (!container) return res.status(404).json({ error: '小说库没有准备好' });
    const dup = db
      .prepare("SELECT id FROM packs WHERE character_id = ? AND kind = 'novel' AND title = ?")
      .get(container.id, title);
    if (dup) return res.status(409).json({ error: `已经有「${title}」这个书袋了` });
    const id = Number(
      db
        .prepare(
          `INSERT INTO packs(character_id, title, month, category, kind, tags, sort_order, created_at)
           VALUES(?,?,NULL,NULL,'novel',?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
        )
        .run(container.id, title, JSON.stringify([title]), container.id, nowIso()).lastInsertRowid
    );
    res.json({ id, title, bookCount: 0 });
  });

  app.get('/api/shelves/:id/novel', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(404).json({ error: '库不存在' });
    if (shelf.kind !== 'novel') return res.status(400).json({ error: '不是小说库' });

    const variant = normalizeVariant(shelf.variant);
    const values = novelViewsOf(shelf);
    const view = values.includes(String(req.query.view || '').trim()) ? String(req.query.view).trim() : '';
    const group = String(req.query.group || '').trim();
    const q = String(req.query.q || '').trim();
    const sort = String(req.query.sort || 'media');

    const base = ['c.shelf_id = @shelfId', 'c.is_container = 0'];
    const baseParams = { shelfId };
    if (view) {
      base.push('c.novel_subtype = @view');
      baseParams.view = view;
    }

    // 视图计数：只按整库算，不随 group / q 变化（切 tab 时数字必须稳）
    const totalAll = db
      .prepare('SELECT COUNT(*) n FROM characters WHERE shelf_id = ? AND is_container = 0')
      .get(shelfId).n;
    const subRows = db
      .prepare(
        `SELECT COALESCE(novel_subtype,'') AS v, COUNT(*) n FROM characters
          WHERE shelf_id = ? AND is_container = 0 GROUP BY COALESCE(novel_subtype,'')`
      )
      .all(shelfId);
    const subMap = Object.fromEntries(subRows.map((r) => [r.v, r.n]));
    const views = [
      { value: '', label: '全部', count: totalAll },
      ...values.map((v) => ({ value: v, label: v, count: subMap[v] || 0 })),
    ];
    // 没填分类的书不会出现在任何子视图里，给前端留个提示用的计数
    const unsorted = subRows.filter((r) => !values.includes(r.v)).reduce((a, r) => a + r.n, 0);

    // 分组统计：跟着 view 走，但不跟 group / q（否则搜索一次分组就没了）
    const groupRows = db
      .prepare(
        `SELECT COALESCE(c.novel_group,'') AS g, COALESCE(c.novel_subtype,'') AS v, COUNT(*) n
           FROM characters c WHERE ${base.join(' AND ')}
          GROUP BY COALESCE(c.novel_group,''), COALESCE(c.novel_subtype,'')`
      )
      .all(baseParams);
    const groupMap = new Map();
    for (const r of groupRows) {
      const g = groupMap.get(r.g) || { name: r.g, count: 0, subs: {} };
      g.count += r.n;
      if (r.v) g.subs[r.v] = (g.subs[r.v] || 0) + r.n;
      groupMap.set(r.g, g);
    }
    const groups = [...groupMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN')
    );

    const where = [...base];
    const params = { ...baseParams };
    if (group) {
      where.push(`COALESCE(c.novel_group,'') = @group`);
      params.group = group;
    }
    if (q) {
      where.push('(c.name LIKE @q OR c.author LIKE @q OR c.novel_group LIKE @q)');
      params.q = `%${q}%`;
    }
    const order =
      sort === 'name'
        ? 'ORDER BY c.name COLLATE NOCASE'
        : sort === 'words'
          ? 'ORDER BY c.word_count DESC, media_count DESC, c.id DESC'
          : sort === 'recent'
            ? 'ORDER BY c.updated_at DESC, c.id DESC'
            : 'ORDER BY media_count DESC, pack_count DESC, c.id DESC';
    const rows = db.prepare(`${CHAR_SELECT} WHERE ${where.join(' AND ')} ${order}`).all(params);

    res.json({
      shelf: { id: shelf.id, name: shelf.name, note: shelf.note, kind: 'novel', variant },
      views,
      groups,
      unsorted,
      items: rows.map((r) => mapChar(r, tagsOf(db, r.id))),
      total: rows.length,
    });
  });

  /**
   * 表情包首页：库里没有条目层级，直接给「图包 + 未分类 + 全部素材」三类。
   * 图包带上前 9 张图，前端拼成 3×3 封面。
   */
  app.get('/api/shelves/:id/emoji', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(404).json({ error: '库不存在' });
    const container = ensureShelfContainer(shelfId);
    if (!container) return res.status(404).json({ error: '表情包没有准备好' });

    const packs = db
      .prepare(
        `SELECT p.id, p.title, p.month, p.category, p.tags, p.created_at, p.cover_media_id,
           (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id) AS media_count,
           (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND (m.anim = 1 OR m.kind = 'video')) AS anim_count,
           (SELECT COALESCE(SUM(m.bytes),0) FROM media m WHERE m.pack_id = p.id) AS bytes
         FROM packs p WHERE p.character_id = ?
         ORDER BY p.sort_order, p.id`
      )
      .all(container.id);

    // 一次取完按包分组，避免 30 个图包发 30 条查询
    const rows = db
      .prepare(
        `SELECT id, pack_id FROM media
         WHERE character_id = ? AND pack_id IS NOT NULL AND kind = 'image'
         ORDER BY pack_id, sort_order, id`
      )
      .all(container.id);
    const byPack = new Map();
    for (const r of rows) {
      const arr = byPack.get(r.pack_id) || [];
      if (arr.length < 9) arr.push(r.id);
      byPack.set(r.pack_id, arr);
    }
    // 手动设过封面的，拼图第一格就用它（封面可能排在很后面，不在前 9 张里）
    for (const p of packs) {
      const arr = byPack.get(p.id);
      if (!arr || !p.cover_media_id) continue;
      const i = arr.indexOf(p.cover_media_id);
      if (i > 0) {
        arr.splice(i, 1);
        arr.unshift(p.cover_media_id);
      } else if (i < 0) {
        arr.pop();
        arr.unshift(p.cover_media_id);
      }
    }

    const stat = db
      .prepare(
        `SELECT COUNT(*) total,
           SUM(CASE WHEN pack_id IS NULL THEN 1 ELSE 0 END) loose,
           SUM(CASE WHEN anim = 1 OR kind = 'video' THEN 1 ELSE 0 END) anim,
           SUM(CASE WHEN anim = 1 AND kind = 'image' THEN 1 ELSE 0 END) gifs,
           SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) videos,
           COALESCE(SUM(bytes),0) bytes
         FROM media WHERE character_id = ?`
      )
      .get(container.id);

    res.json({
      shelf: { id: shelf.id, name: shelf.name, note: shelf.note, kind: shelf.kind || 'emoji' },
      containerId: container.id,
      stats: {
        total: stat.total || 0,
        loose: stat.loose || 0,
        anim: stat.anim || 0,
        gifs: stat.gifs || 0,
        videos: stat.videos || 0,
        still: (stat.total || 0) - (stat.anim || 0),
        bytes: stat.bytes || 0,
        packs: packs.length,
      },
      packs: packs.map((p) => ({
        id: p.id,
        title: p.title,
        month: p.month,
        category: p.category,
        tags: safeJson(p.tags),
        createdAt: p.created_at,
        mediaCount: p.media_count,
        animCount: p.anim_count,
        bytes: p.bytes || 0,
        coverMediaId: p.cover_media_id || null,
        thumbs: byPack.get(p.id) || [],
      })),
    });
  });

  // ---------- 收件箱（未分发 / 已分发）----------
  /**
   * 「收件箱」不是真的把所有文件复制一份进来，而是两种查询：
   *  - 未分发：媒体挂在库的隐藏容器条目下面，文件在 <库名>/未分类/图片|视频
   *  - 已分发：库里**其它所有**媒体，只读聚合（点开还是走 /i/:id 原页）
   * 分发动作不在这里：直接复用 POST /api/packs/:id/media（跨条目移动会搬文件 + 写 journal）。
   */
  app.get('/api/shelves/:id/inbox', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(404).json({ error: '库不存在' });
    if ((shelf.kind || '') !== 'inbox') return res.status(400).json({ error: '不是收件箱' });
    const container = ensureShelfContainer(shelfId);
    if (!container) return res.status(404).json({ error: '收件箱没有准备好' });

    const section = String(req.query.section || '') === 'distributed' ? 'distributed' : 'undistributed';
    const kind = ['image', 'video'].includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(300, Math.max(24, Number(req.query.pageSize) || 120));

    // 一块用容器 id 过滤，另一块取反；kind 只认图片/视频（小说正文那种 file 不进这里）
    const sideOf = (sec) =>
      sec === 'undistributed' ? 'm.character_id = @containerId' : 'm.character_id <> @containerId';
    const cond = [sideOf(section), "m.kind IN ('image','video')"];
    const params = { containerId: container.id };
    if (kind) {
      cond.push('m.kind = @kind');
      params.kind = kind;
    }
    // 文件名 + 所属条目名都能搜：已分发那边只看文件名等于大海捞针
    if (q) {
      cond.push('(m.file_name LIKE @q OR c.name LIKE @q OR p.title LIKE @q)');
      params.q = `%${q}%`;
    }
    const from = `FROM media m
      JOIN characters c ON c.id = m.character_id
      LEFT JOIN packs p ON p.id = m.pack_id
      LEFT JOIN shelves sh ON sh.id = c.shelf_id`;
    const where = cond.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) n ${from} WHERE ${where}`).get(params).n;
    // 四个角标：不跟 q 走，切视图时数字要稳
    const countPair = (sec) => {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN m.kind = 'image' THEN 1 ELSE 0 END) AS images,
             SUM(CASE WHEN m.kind = 'video' THEN 1 ELSE 0 END) AS videos
           FROM media m WHERE ${sideOf(sec)} AND m.kind IN ('image','video')`
        )
        .get({ containerId: container.id });
      return { image: row.images || 0, video: row.videos || 0 };
    };
    const counts = { undistributed: countPair('undistributed'), distributed: countPair('distributed') };

    const rows = db
      .prepare(
        `SELECT m.*, c.name AS char_name, c.is_container,
                sh.id AS shelf_id, sh.name AS shelf_name, sh.kind AS shelf_kind,
                p.title AS pack_title
         ${from}
         WHERE ${where}
         ORDER BY m.id DESC
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

    const packTags = new Map();
    const packIds = [...new Set(rows.map((r) => r.pack_id).filter(Boolean))];
    if (packIds.length) {
      const got = db
        .prepare(`SELECT id, tags FROM packs WHERE id IN (${packIds.map(() => '?').join(',')})`)
        .all(...packIds);
      for (const r of got) packTags.set(r.id, safeJson(r.tags));
    }

    res.json({
      shelf: { id: shelf.id, name: shelf.name, note: shelf.note, kind: shelf.kind },
      containerId: container.id,
      section,
      kind,
      q,
      page,
      pageSize,
      total,
      counts,
      items: rows.map((r) => ({
        ...mapMedia(r),
        tags: mergeTags(r.tags ? safeJson(r.tags) : [], [], packTags.get(r.pack_id) || []),
        packTitle: r.pack_title || '',
        charName: r.char_name,
        shelfId: r.shelf_id,
        shelfName: r.shelf_name || '',
        shelfKind: r.shelf_kind || '',
        container: !!r.is_container,
      })),
    });
  });

  // ---------- 作品录（游戏 / 动画 / 电影 / 剧集）----------
  /**
   * 资源卡片复用 characters 行：name=资源名、category=分类、tags=标签。
   * 它和「角色 / 人物」的关系完全靠标签（同名标签）或出处（platforms.handle）建立，
   * 不额外建关联表，这样在条目上打个「原神」标签就自动挂上去了。
   */
  /**
   * 关联条目数：**标签或出处**，命中一条就够。
   * 以前是两段各自 COUNT 再相加 —— 同一张卡既打了标签、又填了出处时会被数两次，
   * 232 个角色显示成 465。改成「满足任一条件的角色数」。
   */
  const RESOURCE_LINKED = `
    (SELECT COUNT(*) FROM characters c2
      WHERE c2.is_container = 0 AND c2.id <> c.id
        AND (
          EXISTS (SELECT 1 FROM character_tags ct2 JOIN tags t2 ON t2.id = ct2.tag_id
                   WHERE ct2.character_id = c2.id AND t2.name = c.name)
          OR c2.platforms LIKE ('%"handle":"' || c.name || '"%')
        ))`;

  // 没设封面时，自动借一个关联条目的封面：优先「角色集」（作品里的角色更像封面）
  const RESOURCE_COVER = `
    COALESCE(c.cover_media_id,
      (SELECT c4.cover_media_id FROM characters c4
         JOIN shelves sh4 ON sh4.id = c4.shelf_id
        WHERE c4.is_container = 0 AND c4.id <> c.id AND c4.cover_media_id IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM character_tags ct4 JOIN tags t4 ON t4.id = ct4.tag_id
                    WHERE ct4.character_id = c4.id AND t4.name = c.name)
            OR c4.platforms LIKE ('%"handle":"' || c.name || '"%')
          )
        ORDER BY CASE sh4.kind WHEN 'work' THEN 0 WHEN 'people' THEN 1 ELSE 2 END, c4.id
        LIMIT 1))`;

  app.get('/api/shelves/:id/resources', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(404).json({ error: '库不存在' });
    const rows = db
      .prepare(
        `SELECT c.*, ${RESOURCE_COVER} AS cover,
                ${RESOURCE_LINKED} AS linked
         FROM characters c
         WHERE c.shelf_id = ? AND c.is_container = 0
         ORDER BY c.sort_order, c.id`
      )
      .all(shelfId);

    const cats = new Map();
    for (const r of rows) {
      const k = r.category || '其他';
      cats.set(k, (cats.get(k) || 0) + 1);
    }
    res.json({
      shelf: { id: shelf.id, name: shelf.name, note: shelf.note, kind: shelf.kind || 'resource' },
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category || '',
        intro: r.intro || '',
        dirSlug: r.dir_slug,
        tags: tagsOf(db, r.id).filter((t) => t !== r.name),
        // 别名要给：列表页的「编辑资源」会把这一栏回填，缺了它一保存就把别名清空了
        aliases: safeJson(r.aliases),
        coverMediaId: r.cover || null,
        linked: r.linked || 0,
      })),
      groups: [...cats.entries()].map(([name, count]) => ({ name, count })),
      total: rows.length,
    });
  });

  /** 出处点击时用它把「原神」这个名字换成资源详情页 */
  app.get('/api/resources/index', (req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.shelf_id, c.category
         FROM characters c JOIN shelves sh ON sh.id = c.shelf_id
         WHERE sh.kind = 'resource' AND c.is_container = 0
         ORDER BY c.sort_order, c.id`
      )
      .all();
    res.json({
      items: rows.map((r) => ({ id: r.id, name: r.name, shelfId: r.shelf_id, category: r.category || '' })),
    });
  });

  /**
   * 出处里写了新作品名 → 自动在作品录建一张卡片（分类 = 出处类型）。
   * 作品录不存在就顺手建一个，这样「只填名字 + 出处」也能自洽。
   */
  app.post('/api/resources/ensure', async (req, res) => {
    const db = getDb();
    const name = String((req.body && req.body.name) || '').trim();
    const category = String((req.body && req.body.category) || '').trim().slice(0, 20);
    if (!name) return res.status(400).json({ error: '作品名不能为空' });

    let shelf = db
      .prepare("SELECT * FROM shelves WHERE kind = 'resource' ORDER BY sort_order, id LIMIT 1")
      .get();
    let createdShelf = false;
    if (!shelf) {
      const lib = mainLibrary();
      const sid = Number(
        db
          .prepare(
            `INSERT INTO shelves(library_id, name, note, kind, sort_order, created_at, updated_at)
             VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM shelves WHERE library_id=?),?,?)`
          )
          .run(lib.id, '作品录', '', 'resource', lib.id, nowIso(), nowIso()).lastInsertRowid
      );
      shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(sid);
      createdShelf = true;
    }

    const found = db
      .prepare('SELECT id FROM characters WHERE shelf_id = ? AND is_container = 0 AND name = ?')
      .get(shelf.id, name);
    if (found) {
      return res.json({ id: found.id, shelfId: shelf.id, created: false, createdShelf });
    }

    const dirSlug = await uniqueCharRelDir(db, shelf.id, name);
    const ts = nowIso();
    const id = Number(
      db
        .prepare(
          `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, category, sort_order, created_at, updated_at)
           VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?)`
        )
        .run(shelf.id, name.slice(0, 100), '', '', dirSlug, category || null, shelf.id, ts, ts)
        .lastInsertRowid
    );
    ensureSelfTags(db); // 资源名本身也是标签，标签库里能搜到
    await ensureOfficialPack(db, id, dirSlug); // 出处里新建的作品也预置「官方」图包
    res.json({ id, shelfId: shelf.id, created: true, createdShelf });
  });

  app.get('/api/resources/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db
      .prepare(
        `SELECT c.*, sh.name AS shelf_name, sh.kind AS shelf_kind, ${RESOURCE_COVER} AS cover
         FROM characters c LEFT JOIN shelves sh ON sh.id = c.shelf_id
         WHERE c.id = ?`
      )
      .get(id);
    if (!row) return res.status(404).json({ error: '资源不存在' });

    const related = db
      .prepare(
        `SELECT c.*, sh.kind AS shelf_kind, sh.name AS shelf_name,
           (SELECT COUNT(*) FROM media m WHERE m.character_id = c.id) AS media_count,
           (SELECT COUNT(*) FROM packs p WHERE p.character_id = c.id) AS pack_count
         FROM characters c JOIN shelves sh ON sh.id = c.shelf_id
         WHERE c.is_container = 0 AND c.id <> @id AND sh.kind IN ('people','work','novel')
           AND (
             EXISTS (SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
                     WHERE ct.character_id = c.id AND t.name = @name)
             OR c.platforms LIKE @like
           )
         ORDER BY CASE sh.kind WHEN 'work' THEN 0 ELSE 1 END, media_count DESC, c.name`
      )
      .all({ id, name: row.name, like: `%"handle":"${row.name}"%` });

    res.json({
      resource: {
        id: row.id,
        name: row.name,
        category: row.category || '',
        intro: row.intro || '',
        coverMediaId: row.cover || null,
        // ownCoverId = 资源自己设过的封面（null 表示用自动借来的）
        ownCoverId: row.cover_media_id || null,
        // 资源详情是手写字段（不走 mapChar），新增列必须在这里也带出来一次
        aliases: safeJson(row.aliases),
        tags: tagsOf(db, row.id).filter((t) => t !== row.name),
        shelf: { id: row.shelf_id, name: row.shelf_name || '', kind: row.shelf_kind || 'resource' },
      },
      related: related.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.shelf_kind,
        shelfName: r.shelf_name,
        account: r.account || '',
        aliases: safeJson(r.aliases),
        mediaCount: r.media_count || 0,
        packCount: r.pack_count || 0,
        coverMediaId: r.cover_media_id,
        viaTag: true,
      })),
    });
  });

  /**
   * 关联到某个作品的候选条目：人物 / 角色 / 小说里还没关联上的。
   *
   * `q` 直接打服务端（名称 / 别名 / 平台账号），条目上千也能搜；
   * 「已关联」的判定和详情页的 related 查询保持一致（同名标签 or 同名出处）。
   */
  app.get('/api/resources/:id/candidates', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id, name FROM characters WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '资源不存在' });

    const q = String(req.query.q || '').trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    const like = `%"handle":"${row.name}"%`;

    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.account, c.cover_media_id,
           sh.name AS shelf_name, sh.kind AS shelf_kind,
           (SELECT COUNT(*) FROM media m WHERE m.character_id = c.id) AS media_count,
           (SELECT COUNT(*) FROM packs p WHERE p.character_id = c.id) AS pack_count
         FROM characters c JOIN shelves sh ON sh.id = c.shelf_id
         WHERE c.is_container = 0 AND c.id <> @id AND sh.kind IN ('people','work','novel')
           AND NOT EXISTS (SELECT 1 FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
                           WHERE ct.character_id = c.id AND t.name = @name)
           AND c.platforms NOT LIKE @like
           ${q ? 'AND (c.name LIKE @q OR c.account LIKE @q OR c.aliases LIKE @q)' : ''}
         ORDER BY media_count DESC, c.name
         LIMIT @limit`
      )
      .all({ id, name: row.name, like, q: `%${q}%`, limit });

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        account: r.account || '',
        kind: r.shelf_kind,
        shelfName: r.shelf_name || '',
        mediaCount: r.media_count || 0,
        packCount: r.pack_count || 0,
        coverMediaId: r.cover_media_id || null,
      })),
    });
  });

  /**
   * 批量改「作品 ↔ 条目」的关联。
   *
   * 关联的本体只有两样：**同名标签** 和 **platforms 里的同名出处**，
   * 所以这里只动这两样，不碰媒体、不碰目录。
   *   add    补上标签（已有就跳过，不覆盖这个条目的其它标签）
   *   remove 去掉标签 + 去掉同名出处
   *   move   先按 remove 清掉本作品的痕迹，再补上目标作品的标签
   *
   * body: { ids: number[], action: 'add' | 'remove' | 'move', targetId? }
   */
  app.post('/api/resources/:id/related', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const self = db.prepare('SELECT id, name FROM characters WHERE id = ?').get(id);
    if (!self) return res.status(404).json({ error: '资源不存在' });

    const b = req.body || {};
    const action = String(b.action || 'add');
    if (!['add', 'remove', 'move'].includes(action)) return res.status(400).json({ error: '未知操作' });

    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => n > 0 && n !== id))];
    if (!ids.length) return res.status(400).json({ error: '没有选中条目' });

    let target = null;
    if (action === 'move') {
      const tid = Number(b.targetId);
      target =
        tid && tid !== id
          ? db
              .prepare(
                `SELECT c.id, c.name FROM characters c JOIN shelves sh ON sh.id = c.shelf_id
                 WHERE c.id = ? AND sh.kind = 'resource'`
              )
              .get(tid)
          : null;
      if (!target) return res.status(400).json({ error: '目标作品不存在' });
    }

    const sameHandle = (p, name) => String(p.handle || '').trim() === name;
    let changed = 0;

    const tx = db.transaction(() => {
      for (const cid of ids) {
        const row = db.prepare('SELECT id, platforms FROM characters WHERE id = ?').get(cid);
        if (!row) continue;
        let tags = tagsOf(db, cid);
        const before = safeJson(row.platforms);

        if (action === 'add') {
          if (!tags.includes(self.name)) tags.push(self.name);
        } else {
          tags = tags.filter((t) => t !== self.name);
          if (action === 'move' && !tags.includes(target.name)) tags.push(target.name);
        }
        applyTags(db, cid, tags);

        // 出处也是关联依据之一：留着它的话，「移除」之后条目还会挂在这个作品下面
        if (action !== 'add') {
          const after = before.filter((p) => !sameHandle(p, self.name));
          if (after.length !== before.length) {
            db.prepare('UPDATE characters SET platforms = ?, updated_at = ? WHERE id = ?').run(
              JSON.stringify(after),
              nowIso(),
              cid
            );
          }
        }
        changed += 1;
      }
      ensureSelfTags(db); // 条目自己的名字标签删不掉
    });
    tx();

    res.json({ ok: true, changed, action });
  });

  /**
   * 批量导入「别名 + 简介」。
   *
   * 前端把 AI 生成的文本解析成 items，这里只负责：按名字在库里找到条目 → 合并别名 → 写简介。
   * 为什么放服务端：同名匹配要走 SQL（还要考虑隐藏容器、同库范围），前端拉全量列表去比对
   * 既慢又容易和库里的真实状态不一致。
   *
   * 只碰 aliases 与 intro 两个字段，名字 / 分类 / 标签 / 封面 / 素材一概不动。
   * `dryRun !== false` 时只返回匹配结果，不写库（前端用它做粘贴后的实时预览）。
   */
  app.post('/api/characters/bulk-bio', (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((x) => ({
        name: String((x && x.name) || '').trim().slice(0, 100),
        aliases: cleanAliases(x && x.aliases),
        intro: String((x && x.intro) || '').slice(0, 20000),
      }))
      .filter((x) => x.name);
    if (!items.length) return res.status(400).json({ error: '没有解析出条目' });

    const shelfId = b.shelfId ? Number(b.shelfId) : null;
    const overwriteIntro = b.overwriteIntro === true;
    // 默认合并：AI 给的别名通常只是补充，直接替换会把手工加过的（比如日文名）冲掉
    const aliasMode = b.aliasMode === 'replace' ? 'replace' : 'merge';
    const dryRun = b.dryRun !== false;

    const pick = shelfId
      ? db.prepare('SELECT id, name, intro, aliases FROM characters WHERE shelf_id = ? AND is_container = 0 AND name = ?')
      : db.prepare('SELECT id, name, intro, aliases FROM characters WHERE is_container = 0 AND name = ?');

    const updated = [];
    const skipped = [];

    const plan = [];
    for (const it of items) {
      const rows = shelfId ? pick.all(shelfId, it.name) : pick.all(it.name);
      if (!rows.length) {
        skipped.push({ name: it.name, reason: '未找到同名条目' });
        continue;
      }
      if (rows.length > 1) {
        skipped.push({ name: it.name, reason: `匹配到 ${rows.length} 个同名条目，未处理`, ids: rows.map((r) => r.id) });
        continue;
      }
      const row = rows[0];
      let prev = [];
      try {
        const parsed = JSON.parse(row.aliases || '[]');
        prev = Array.isArray(parsed) ? parsed : [];
      } catch {
        prev = [];
      }
      const base = aliasMode === 'merge' ? prev : [];
      const merged = cleanAliases([...base, ...it.aliases]);
      const prevIntro = String(row.intro || '');
      const introChanged = !!it.intro && (overwriteIntro || !prevIntro.trim());
      // 别名一条没多、简介没变化 —— 这条就是「无变化」，别报成已更新
      const aliasAdded = merged.filter((a) => !prev.includes(a)).length;
      if (!aliasAdded && !introChanged) {
        skipped.push({
          name: it.name,
          reason: prevIntro.trim() && it.intro && !overwriteIntro ? '已有简介 · 别名无新增' : '没有变化',
        });
        continue;
      }
      plan.push({ row, merged, intro: it.intro, introChanged, aliasAdded, prevIntro });
    }

    if (dryRun) {
      return res.json({
        dryRun: true,
        total: items.length,
        matched: plan.length,
        skipped,
        items: plan.map((p) => ({
          id: p.row.id,
          name: p.row.name,
          aliasAdded: p.aliasAdded,
          aliasTotal: p.merged.length,
          introChanged: p.introChanged,
          hasIntro: !!p.prevIntro.trim(),
          introLength: p.intro.length,
        })),
      });
    }

    const ts = nowIso();
    const tx = db.transaction(() => {
      for (const p of plan) {
        if (p.aliasAdded > 0) {
          db.prepare('UPDATE characters SET aliases = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(p.merged),
            ts,
            p.row.id
          );
        }
        if (p.introChanged) {
          db.prepare('UPDATE characters SET intro = ?, updated_at = ? WHERE id = ?').run(p.intro, ts, p.row.id);
        }
        updated.push({
          id: p.row.id,
          name: p.row.name,
          aliasAdded: p.aliasAdded,
          aliasTotal: p.merged.length,
          introChanged: p.introChanged,
        });
      }
    });
    tx();
    res.json({ dryRun: false, total: items.length, matched: updated.length, skipped, items: updated });
  });

  app.post('/api/characters', async (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: '角色名不能为空' });
    const shelfId = Number(b.shelfId) || defaultShelfId();
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
    if (!shelf) return res.status(400).json({ error: '库不存在' });
    const isNovel = shelf.kind === 'novel';

    // 小说库：一本书必须落在某个归类文件夹里
    const novelGroup = isNovel ? String(b.novelGroup || '').trim().slice(0, 60) : '';
    if (isNovel && !novelGroup) return res.status(400).json({ error: '请先选一个归类文件夹' });

    // 同库内不允许重名，跨库同名合法（原创书《原神》与同人书分组「原神」互不干扰）。
    // 以前只拦小说库，人物 / 角色集重名会静默建出第二个条目 + 「名字-2」目录。
    const dupName = name.slice(0, 100);
    const dup = sameNameChar(db, shelfId, dupName);
    if (dup) {
      return res.status(409).json({ error: `这个库里已经有「${dupName}」了`, id: dup.id, dirSlug: dup.dir_slug });
    }

    const dirSlug = await uniqueCharRelDir(db, shelfId, name, novelGroup);
    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, category, aliases,
           novel_group, novel_subtype, author, word_count, novel_status, sort_order, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?)`
      )
      .run(
        shelfId,
        name.slice(0, 100),
        String(b.account || '').slice(0, 100),
        String(b.intro || '').slice(0, 20000),
        dirSlug,
        String(b.category || '').trim().slice(0, 20) || null,
        JSON.stringify(cleanAliases(b.aliases)),
        isNovel ? novelGroup : null,
        isNovel ? pickNovelSubtype(shelf, b.novelSubtype) : null,
        isNovel ? String(b.author || '').trim().slice(0, 60) || null : null,
        isNovel ? Math.max(0, Number(b.wordCount) || 0) : 0,
        isNovel ? String(b.novelStatus || '').trim().slice(0, 20) || null : null,
        shelfId,
        ts,
        ts
      );
    const id = Number(info.lastInsertRowid);
    if (Array.isArray(b.tags) && b.tags.length) applyTags(db, id, b.tags);
    ensureSelfTags(db); // 新条目立刻带上自己的名字标签
    if (shelf.kind === 'people' || shelf.kind === 'work') await ensureCharDirs(dirSlug);
    // 小说库：正文文件目录 + 插图目录（不建视频，空目录只是噪音）
    else if (isNovel) await ensureCharDirs(dirSlug, true);
    // 作品录：每张「作品」卡预置一个「官方」图包 + 对应目录
    else if (shelf.kind === 'resource') await ensureOfficialPack(db, id, dirSlug);
    // 建书时填的类型 / 原作就是书袋名，顺手把书袋建出来
    if (isNovel) ensureNovelBag(db, shelf.id, novelGroup);
    // 同人小说自动带「原作品名」标签 —— 作品录那张作品卡的「关联条目」正是按同名标签统计的
    if (isNovel && normalizeVariant(shelf.variant) === 'fanfic' && novelGroup) {
      applyTags(db, id, [...new Set([...(Array.isArray(b.tags) ? b.tags : []), novelGroup])]);
    }
    const row = db.prepare(`${CHAR_SELECT} WHERE c.id = ?`).get(id);
    const dirName = dirSlug.split('/').pop();
    logOp(db, {
      entity: 'character',
      entityId: id,
      action: 'create',
      payload: { name, dirSlug, kind: shelf.kind || '' },
    });
    res.json({ ...mapChar(row, tagsOf(db, id)), dirRenamed: dirName !== slugify(name) });
  });

  app.get('/api/characters/:id', (req, res) => {
    const db = getDb();
    const row = db.prepare(`${CHAR_SELECT} WHERE c.id = ?`).get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '角色不存在' });
    const kinds = db
      .prepare('SELECT kind, COUNT(*) n FROM media WHERE character_id = ? GROUP BY kind')
      .all(row.id);
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));
    // shelf 由 mapChar 带出（含 kind），这里不要再覆盖，否则前端拿不到库类型
    res.json({
      ...mapChar(row, tagsOf(db, row.id)),
      stats: {
        image: byKind.image || 0,
        video: byKind.video || 0,
        // 小说库的「文件」= 正文（txt / epub / pdf …）
        file: byKind.file || 0,
        total: (byKind.image || 0) + (byKind.video || 0) + (byKind.file || 0),
      },
    });
  });

  /** 小说的正文文件列表（kind='file'）：详情页「正文」那一块用 */
  app.get('/api/characters/:id/texts', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) {
      return res.status(404).json({ error: '条目不存在' });
    }
    const rows = db
      .prepare(
        `SELECT id, file_name, ext, bytes, created_at FROM media
          WHERE character_id = ? AND kind = 'file' ORDER BY file_name`
      )
      .all(id);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        fileName: r.file_name,
        ext: String(r.ext || '').replace(/^\./, '').toLowerCase(),
        bytes: r.bytes,
        createdAt: r.created_at,
      })),
      total: rows.length,
    });
  });

  app.patch('/api/characters/:id', async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '角色不存在' });
    const b = req.body || {};
    const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(row.shelf_id);
    const isNovel = !!shelf && shelf.kind === 'novel';

    /* 小说库的目录 = <库>/<归类文件夹>/<书名>。
       改书名或改归类文件夹时目录必须跟着搬，否则界面一套、磁盘一套。
       目录搬运用异步 fs，放在事务外；DB 更新失败再把目录搬回去。 */
    const nextName = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 100) : row.name;
    const nextGroup =
      typeof b.novelGroup === 'string' ? b.novelGroup.trim().slice(0, 60) : String(row.novel_group || '');

    // 改名或者换库都要重新查重名 —— 同库不允许两个同名条目。
    // 只改简介 / 别名这类操作不查，省一次查询。
    const nextShelfId = b.shelfId ? Number(b.shelfId) : row.shelf_id;
    if (nextName !== row.name || nextShelfId !== row.shelf_id) {
      const dup = sameNameChar(db, nextShelfId, nextName, id);
      if (dup) return res.status(409).json({ error: `这个库里已经有「${nextName}」了`, id: dup.id });
    }

    let targetRel = row.dir_slug;
    if (isNovel) {
      if (!nextGroup) return res.status(400).json({ error: '归类文件夹不能为空' });
      const shelfSlug = shelfSlugOf(db, row.shelf_id);
      targetRel = `${shelfSlug}/${slugify(nextGroup)}/${slugify(nextName)}`;
    }
    let mv = null;
    if (isNovel && targetRel !== row.dir_slug) mv = await moveNovelDir(db, row, targetRel);

    try {
      const tx = db.transaction(() => {
        if (typeof b.name === 'string' && b.name.trim()) {
          db.prepare('UPDATE characters SET name = ?, updated_at = ? WHERE id = ?').run(nextName, nowIso(), id);
        }
        if (typeof b.account === 'string') {
          db.prepare('UPDATE characters SET account = ?, updated_at = ? WHERE id = ?').run(b.account.slice(0, 100), nowIso(), id);
        }
        if (typeof b.intro === 'string') {
          db.prepare('UPDATE characters SET intro = ?, updated_at = ? WHERE id = ?').run(b.intro.slice(0, 20000), nowIso(), id);
        }
        if (typeof b.category === 'string') {
          db.prepare('UPDATE characters SET category = ?, updated_at = ? WHERE id = ?').run(
            b.category.trim().slice(0, 20) || null,
            nowIso(),
            id
          );
        }
        if (b.coverMediaId !== undefined) {
          db.prepare('UPDATE characters SET cover_media_id = ?, updated_at = ? WHERE id = ?').run(
            b.coverMediaId === null ? null : Number(b.coverMediaId), nowIso(), id
          );
        }
        if (Array.isArray(b.tags)) applyTags(db, id, b.tags);
        if (Array.isArray(b.aliases)) {
          db.prepare('UPDATE characters SET aliases = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(cleanAliases(b.aliases)),
            nowIso(),
            id
          );
        }
        if (Array.isArray(b.platforms)) {
          const clean = b.platforms
            .filter((x) => x && (String(x.handle || '').trim() || String(x.url || '').trim()))
            .slice(0, 30)
            .map((x) => ({
              platform: String(x.platform || '').trim().slice(0, 20) || '其他',
              handle: String(x.handle || '').trim().slice(0, 80),
              url: normalizeUrl(x.url),
            }));
          db.prepare('UPDATE characters SET platforms = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(clean),
            nowIso(),
            id
          );
        }
        if (b.shelfId) {
          db.prepare('UPDATE characters SET shelf_id = ?, updated_at = ? WHERE id = ?').run(Number(b.shelfId), nowIso(), id);
        }
        if (isNovel) {
          if (typeof b.novelGroup === 'string') {
            db.prepare('UPDATE characters SET novel_group = ?, updated_at = ? WHERE id = ?').run(nextGroup, nowIso(), id);
            // 填了一个新类型 / 原作，就顺手把这个书袋建出来
            ensureNovelBag(db, shelf.id, nextGroup);
          }
          if (b.novelSubtype !== undefined) {
            db.prepare('UPDATE characters SET novel_subtype = ?, updated_at = ? WHERE id = ?').run(
              pickNovelSubtype(shelf, b.novelSubtype),
              nowIso(),
              id
            );
          }
          if (typeof b.author === 'string') {
            db.prepare('UPDATE characters SET author = ?, updated_at = ? WHERE id = ?').run(
              b.author.trim().slice(0, 60) || null,
              nowIso(),
              id
            );
          }
          if (b.wordCount !== undefined) {
            db.prepare('UPDATE characters SET word_count = ?, updated_at = ? WHERE id = ?').run(
              Math.max(0, Number(b.wordCount) || 0),
              nowIso(),
              id
            );
          }
          if (typeof b.novelStatus === 'string') {
            db.prepare('UPDATE characters SET novel_status = ?, updated_at = ? WHERE id = ?').run(
              b.novelStatus.trim().slice(0, 20) || null,
              nowIso(),
              id
            );
          }
          // dir_slug 与所有媒体路径前缀一起换，媒体记录不能指向已经不存在的旧目录
          if (targetRel !== row.dir_slug) {
            db.prepare('UPDATE characters SET dir_slug = ? WHERE id = ?').run(targetRel, id);
            db.prepare(
              `UPDATE media SET rel_path = ? || substr(rel_path, ?)
                WHERE character_id = ? AND substr(rel_path, 1, ?) = ?`
            ).run(targetRel, row.dir_slug.length + 1, id, row.dir_slug.length, row.dir_slug);
          }
        }
      });
      tx();
    } catch (err) {
      if (mv && mv.moved) await fsp.rename(mv.targetAbs, mv.oldAbs).catch(() => {});
      throw err;
    }
    // 名字标签始终跟着条目走：改名补新名，手删了也会补回来
    ensureSelfTags(db);
    const fresh = db.prepare(`${CHAR_SELECT} WHERE c.id = ?`).get(id);
    res.json({ ...mapChar(fresh, tagsOf(db, id)), dirMoved: !!(mv && mv.moved) });
  });

  app.delete('/api/characters/:id', async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '角色不存在' });

    /* 先清磁盘、再删记录。
       目录里的文件被占用时整次删除失败，条目还在、界面看得见，用户可以关掉占用的程序再来一次；
       反过来（先删记录）失败的话，文件留在磁盘上、却没有任何记录能指向它，等于悄悄漏删。 */
    if (row.dir_slug) {
      const rm = await removeDir(row.dir_slug);
      if (!rm.ok) {
        const warning = await noteDirLeftover(row.dir_slug, rm);
        return res.status(409).json({
          error: warning,
          code: rm.code || null,
          remaining: rm.remaining ?? null,
          kept: true,
        });
      }
    }

    try {
      db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);
    } catch (err) {
      // 文件已经删了、记录没删掉：极少见，但必须留痕（重试一次删除即可清掉空记录）
      await logRecovery({
        kind: 'character-row-delete-failed',
        characterId: row.id,
        dirRel: row.dir_slug,
        error: String(err.message || err),
      });
      return res.status(500).json({ error: `文件已删除，但记录没删掉（${err.message}）`, characterId: row.id });
    }
    pruneOrphanTags(db); // 名字标签别留在池里变成幽灵
    logOp(db, {
      entity: 'character',
      entityId: row.id,
      action: 'delete',
      payload: { name: row.name, dir: row.dir_slug },
    });
    res.json({ ok: true, dirRemoved: !!row.dir_slug });
  });

  // ---------- 图包 ----------
  app.get('/api/characters/:id/packs', (req, res) => {
    const db = getDb();
    const cat = String(req.query.category || '').trim();
    const args = [Number(req.params.id)];
    if (cat) args.push(cat);
    const rows = db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id) AS media_count,
           (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND m.kind='image') AS image_count,
           (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND m.kind='video') AS video_count,
           (SELECT COALESCE(SUM(m.bytes),0) FROM media m WHERE m.pack_id = p.id) AS bytes
         FROM packs p WHERE p.character_id = ? ${cat ? 'AND p.category = ?' : ''}
         ORDER BY p.month IS NULL, p.month DESC, p.id DESC`
      )
      .all(...args);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        month: r.month,
        category: r.category,
        tags: safeJson(r.tags),
        // pack 普通图包 / comic 漫画 / novel 书袋
        kind: r.kind || 'pack',
        mediaCount: r.media_count,
        imageCount: r.image_count,
        videoCount: r.video_count,
        bytes: r.bytes,
        createdAt: r.created_at,
        coverMediaId: r.cover_media_id,
      })),
    });
  });

  app.post('/api/characters/:id/packs', (req, res) => {
    const db = getDb();
    const charId = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(charId)) {
      return res.status(404).json({ error: '角色不存在' });
    }
    const b = req.body || {};
    const category = String(b.category || '').trim().slice(0, 20) || null;
    const rawTitle = String(b.title || '').trim();
    const rawMonth = String(b.month || '').trim();
    const hasTitle = Boolean(rawTitle);
    const hasMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth);

    // 两个字段都允许留空，优先级：名称 > 日期 > 今天
    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const curDate = `${curMonth}-${String(now.getDate()).padStart(2, '0')}`;

    let title;
    let month;
    if (hasTitle) {
      title = rawTitle;
      month = hasMonth ? rawMonth : null;
    } else if (hasMonth) {
      title = monthTitle(rawMonth);
      month = rawMonth;
    } else {
      title = curDate;
      month = curMonth;
    }

    // 同月已存在图包时，不报错打断用户：保留名字、放弃月份归属，名字加序号
    if (month) {
      const dup = db
        .prepare('SELECT id FROM packs WHERE character_id = ? AND month = ? AND category IS ?')
        .get(charId, month, category);
      if (dup) {
        month = null;
        let n = 2;
        let candidate = `${title} (${n})`;
        while (db.prepare('SELECT 1 FROM packs WHERE character_id = ? AND title = ?').get(charId, candidate)) {
          n += 1;
          candidate = `${title} (${n})`;
        }
        title = candidate;
      }
    }

    const id = Number(
      db
        .prepare(
          `INSERT INTO packs(character_id, title, month, category, sort_order, created_at, tags)
           VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?,?)`
        )
        .run(
          charId,
          title.slice(0, 100),
          month,
          category,
          charId,
          nowIso(),
          JSON.stringify(packTagsFor(db, charId, title))
        ).lastInsertRowid
    );
    logOp(db, {
      entity: 'pack',
      entityId: id,
      action: 'create',
      status: initialStatus('pack.create'),
      payload: { title, month, category, charId },
    });
    res.json({ id, title, month, category, autoMonth: !hasTitle && !hasMonth });
  });

  app.get('/api/packs/:id', (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT p.*, c.name AS char_name, c.id AS char_id, c.account AS char_account, c.is_container,
                sh.id AS shelf_id, sh.name AS shelf_name, sh.kind AS shelf_kind
         FROM packs p JOIN characters c ON c.id = p.character_id
         LEFT JOIN shelves sh ON sh.id = c.shelf_id
         WHERE p.id = ?`
      )
      .get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '图包不存在' });
    res.json({
      id: row.id,
      title: row.title,
      // pack 普通图包 / comic 漫画
      kind: row.kind || 'pack',
      month: row.month,
      category: row.category,
      tags: safeJson(row.tags),
      createdAt: row.created_at,
      coverMediaId: row.cover_media_id,
      character: { id: row.char_id, name: row.char_name, account: row.char_account, container: !!row.is_container },
      shelf: { id: row.shelf_id, name: row.shelf_name || '', kind: row.shelf_kind || 'people' },
      counts: db
        .prepare(`SELECT kind, COUNT(*) n FROM media WHERE pack_id = ? GROUP BY kind`)
        .all(row.id)
        .reduce((acc, k) => ({ ...acc, [k.kind]: k.n }), {}),
    });
  });

  app.patch('/api/packs/:id', async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '图包不存在' });
    const b = req.body || {};
    let titleChanged = false;
    try {
      if (typeof b.title === 'string' && b.title.trim()) {
        const nextTitle = b.title.trim().slice(0, 100);
        db.prepare('UPDATE packs SET title = ? WHERE id = ?').run(nextTitle, id);
        titleChanged = nextTitle !== row.title;
        // 名字变了，那条同名标签跟着改；用户自己加的其他标签保留
        const tags = withOwnerTag(db, row.character_id, packTagsKeepingName(safeJson(row.tags), row.title, nextTitle));
        db.prepare('UPDATE packs SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
      }
      if (b.month !== undefined) {
        const m = String(b.month || '').trim();
        const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : null;
        if (valid) {
          const dup = db
            .prepare('SELECT id FROM packs WHERE character_id = ? AND month = ? AND id <> ?')
            .get(row.character_id, valid, id);
          if (dup) return res.status(400).json({ error: '这个月份已经有别的图包了' });
        }
        db.prepare('UPDATE packs SET month = ? WHERE id = ?').run(valid, id);
      }
      if (b.coverMediaId !== undefined) {
        db.prepare('UPDATE packs SET cover_media_id = ? WHERE id = ?').run(
          b.coverMediaId === null ? null : Number(b.coverMediaId), id
        );
      }
      if (Array.isArray(b.tags)) {
        // 「所属条目名」是系统维护的那条，用户取消勾选也补回来，否则标签池里会缺一块
        db.prepare('UPDATE packs SET tags = ? WHERE id = ?').run(JSON.stringify(withOwnerTag(db, row.character_id, b.tags)), id);
      }
    } catch (err) {
      return res.status(400).json({ error: String(err.message || '保存失败') });
    }
    const fresh = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    // 改名顺带把磁盘目录也改了：以前只改数据库，目录还留着旧名，越用越对不上。
    // 只处理「整包在一个目录」的简单情况；散包留给「同步文件夹」一次合并。
    let dirRename = null;
    if (titleChanged) {
      try {
        dirRename = await renamePackDir(db, id);
      } catch (err) {
        dirRename = { ok: false, reason: String(err.message || err) };
      }
      logOp(db, {
        entity: 'pack',
        entityId: id,
        action: 'rename',
        status: dirRename && dirRename.ok ? 'done' : 'failed',
        reason: dirRename && !dirRename.ok ? dirRename.reason || '目录没跟上' : null,
        payload: { from: row.title, to: fresh.title, dir: dirRename || null },
      });
    }
    res.json({
      ok: true,
      id,
      title: fresh.title,
      month: fresh.month,
      createdAt: fresh.created_at,
      coverMediaId: fresh.cover_media_id || null,
      dirRename,
    });
  });

  /**
   * 图包 ⇄ 漫画 转换。
   *
   * 只改 packs.kind 和 media.page_no —— 文件一个都不搬、封面和标签全保留，
   * 所以随时能转回去。页序按文件名自然序（1、2、10），点「重新编号」也能再来一遍。
   */
  app.post('/api/packs/:id/convert', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const pack = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    if (!pack) return res.status(404).json({ error: '图包不存在' });
    if (pack.kind === 'novel') return res.status(400).json({ error: '书袋不能转成漫画' });

    const to = String((req.body && req.body.to) || '').trim();
    if (to !== 'comic' && to !== 'pack') return res.status(400).json({ error: '只能转成 comic 或 pack' });

    if (to === 'pack') {
      // 转回普通图包：页序清空，媒体顺序回到 sort_order（否则会被 page_no 继续支配）
      db.transaction(() => {
        db.prepare('UPDATE media SET page_no = NULL WHERE pack_id = ?').run(id);
        db.prepare("UPDATE packs SET kind = 'pack' WHERE id = ?").run(id);
      })();
      return res.json({ ok: true, kind: 'pack', pages: 0, videos: 0 });
    }

    const rows = db.prepare('SELECT id, kind, file_name FROM media WHERE pack_id = ?').all(id);
    const images = rows.filter((r) => r.kind === 'image');
    const videos = rows.filter((r) => r.kind === 'video');
    if (!images.length) return res.status(400).json({ error: '这个图包里没有图片，转不了漫画' });
    const onlyImages = !!(req.body && req.body.onlyImages);
    if (videos.length && !onlyImages) {
      return res.status(409).json({
        error: `包内有 ${videos.length} 个视频，无法参与漫画阅读`,
        videos: videos.length,
        images: images.length,
      });
    }

    images.sort((a, b) => naturalCompare(a.file_name, b.file_name));
    const setPage = db.prepare('UPDATE media SET page_no = ? WHERE id = ?');
    db.transaction(() => {
      images.forEach((r, i) => setPage.run(i + 1, r.id));
      db.prepare("UPDATE packs SET kind = 'comic' WHERE id = ?").run(id);
    })();

    res.json({ ok: true, kind: 'comic', pages: images.length, videos: videos.length });
  });

  // 默认「解散」：只删图包，里面的媒体变成无包；
  // ?withMedia=1 是「删除」：连图包里的媒体和磁盘文件一起删掉
  app.delete('/api/packs/:id', async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '图包不存在' });
    const withMedia = String(req.query.withMedia || '') === '1';
    // 删之前先把涉及的文件记下来：记录删掉以后，日志里的路径快照就是唯一的线索
    const allMedia = db.prepare('SELECT id, rel_path FROM media WHERE pack_id = ?').all(id);
    const dirsBefore = [...new Set(allMedia.map((m) => m.rel_path.split('/').slice(0, -1).join('/')))];
    let removed = 0;
    const failed = [];
    if (withMedia) {
      const items = allMedia;
      const delOne = db.prepare('DELETE FROM media WHERE id = ?');
      for (const m of items) {
        // 先删文件，删不掉就留着这条记录（变成无包），别让「已删除」变成谎话
        const del = await removeLibraryFile(m.rel_path);
        if (del.ok || del.alreadyGone) {
          delOne.run(m.id);
          removed += 1;
        } else {
          failed.push({ id: m.id, reason: whyDeleteFailed(del), code: del.code || null });
          db.prepare('UPDATE media SET pack_id = NULL WHERE id = ?').run(m.id);
        }
      }
    } else {
      db.prepare('UPDATE media SET pack_id = NULL WHERE pack_id = ?').run(id);
    }
    db.prepare('DELETE FROM packs WHERE id = ?').run(id);
    refreshCharacter(row.character_id);
    // 图包没了，把空掉的目录收走（只删空目录，其他文件一个不动）
    let dirsRemoved = 0;
    try {
      dirsRemoved = pruneDirsOf(dirsBefore, db);
    } catch {
      /* ignore */
    }
    logOp(
      db,
      withMedia
        ? {
            entity: 'pack',
            entityId: id,
            action: 'delete',
            status: failed.length ? 'failed' : 'done',
            reason: failed.length ? `${failed.length} 个文件没删掉` : null,
            payload: { title: row.title, items: allMedia.map((m) => ({ id: m.id, path: m.rel_path })) },
          }
        : {
            entity: 'pack',
            entityId: id,
            action: 'dissolve',
            status: initialStatus('pack.dissolve'),
            payload: {
              title: row.title,
              mediaIds: allMedia.map((m) => m.id),
              dirs: dirsBefore,
            },
          }
    );
    res.json({ ok: true, removed, failed, dirsRemoved });
  });

  /**
   * 图包批量操作：dissolve 只删壳（媒体变成无包），delete 连媒体和磁盘文件一起删。
   */
  app.post('/api/packs/bulk', async (req, res) => {
    const db = getDb();
    const raw = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const action = String((req.body && req.body.action) || '');
    if (!ids.length) return res.status(400).json({ error: '没有选择图包' });
    if (action !== 'dissolve' && action !== 'delete') return res.status(400).json({ error: '未知操作' });

    const getPack = db.prepare('SELECT id, character_id, title FROM packs WHERE id = ?');
    const delPack = db.prepare('DELETE FROM packs WHERE id = ?');

    let done = 0;
    let removed = 0;
    const failed = [];
    const chars = new Set();
    const dirsToPrune = [];
    const delOneMedia = db.prepare('DELETE FROM media WHERE id = ?');
    const looseMedia = db.prepare('UPDATE media SET pack_id = NULL WHERE id = ?');
    for (const id of ids) {
      const pack = getPack.get(id);
      if (!pack) continue;
      chars.add(pack.character_id);
      const rows = db.prepare('SELECT id, rel_path FROM media WHERE pack_id = ?').all(id);
      const failIds = new Set();
      if (action === 'delete') {
        for (const r of rows) {
          dirsToPrune.push(r.rel_path.split('/').slice(0, -1).join('/'));
          const del = await removeLibraryFile(r.rel_path);
          if (del.ok || del.alreadyGone) {
            delOneMedia.run(r.id);
            removed += 1;
          } else {
            failIds.add(r.id);
            failed.push({ id: r.id, packId: id, reason: whyDeleteFailed(del), code: del.code || null });
            looseMedia.run(r.id); // 留在「无包」里，用户还看得见、能再来一次
          }
        }
      }
      // dissolve 时 media.pack_id 有 ON DELETE SET NULL，会自动变成无包
      delPack.run(id);
      done += 1;
      logOp(
        db,
        action === 'delete'
          ? {
              entity: 'pack',
              entityId: id,
              action: 'delete',
              status: failIds.size ? 'failed' : 'done',
              reason: failIds.size ? `${failIds.size} 个文件没删掉` : null,
              payload: { title: pack.title, items: rows.map((r) => ({ id: r.id, path: r.rel_path })) },
            }
          : {
              entity: 'pack',
              entityId: id,
              action: 'dissolve',
              status: initialStatus('pack.dissolve'),
              payload: {
                title: pack.title,
                mediaIds: rows.map((r) => r.id),
                dirs: [...new Set(rows.map((r) => r.rel_path.split('/').slice(0, -1).join('/')))],
              },
            }
      );
    }
    for (const cid of chars) {
      refreshCharacterPacks(cid);
      refreshCharacter(cid);
    }
    // 删完把空掉的图包目录收走（只删空目录，磁盘上的文件一个不动）
    let dirsRemoved = 0;
    try {
      dirsRemoved = pruneDirsOf(dirsToPrune, db);
    } catch {
      /* 清目录失败不影响删除结果 */
    }
    res.json({ ok: true, done, removed, failed, dirsRemoved });
  });

  /**
   * 同步磁盘：让图包目录名跟上数据库里的图包名。
   *
   * GET  .../preview  只算不动（前端弹确认框用）
   * POST              真跑（会移动文件，但不删任何文件；空目录才回收）
   */
  app.get('/api/sync/packs/preview', async (req, res) => {
    try {
      res.json(await syncPackDirs(getDb(), { dryRun: true }));
    } catch (err) {
      res.status(400).json({ error: String(err.message || '同步预览失败') });
    }
  });

  app.post('/api/sync/packs', async (req, res) => {
    try {
      const r = await syncPackDirs(getDb(), { dryRun: false });
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: String(err.message || '同步失败') });
    }
  });

  /* ── 操作日志：增量同步（v3.46） ──────────────────────────────────
     老的 /api/sync/packs* 保留成「全量校验」，日常走下面这几个。 */

  app.get('/api/ops/summary', (req, res) => {
    res.json(opsSummary(getDb()));
  });

  app.get('/api/ops/preview', async (req, res) => {
    try {
      res.json(await applyOps(getDb(), { dryRun: true }));
    } catch (err) {
      res.status(400).json({ error: String(err.message || '预览失败') });
    }
  });

  app.post('/api/ops/apply', async (req, res) => {
    try {
      res.json(await applyOps(getDb(), { dryRun: false }));
    } catch (err) {
      res.status(400).json({ error: String(err.message || '同步失败') });
    }
  });

  app.get('/api/ops', (req, res) => {
    res.json(
      listOps(getDb(), {
        limit: req.query.limit,
        offset: req.query.offset,
        status: String(req.query.status || ''),
        q: String(req.query.q || ''),
      })
    );
  });

  app.post('/api/ops/archive', (req, res) => {
    const days = Number((req.body && req.body.days) || 365);
    res.json({ ok: true, removed: archiveOps(getDb(), days) });
  });

  /** 媒体批量操作：delete 删记录和磁盘文件；move 只改分组（限同一批条目） */
  app.post('/api/media/bulk', async (req, res) => {
    const db = getDb();
    const raw = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const action = String((req.body && req.body.action) || '');
    if (!ids.length) return res.status(400).json({ error: '没有选择媒体' });
    if (action !== 'delete' && action !== 'move') return res.status(400).json({ error: '未知操作' });

    const getRow = db.prepare('SELECT * FROM media WHERE id = ?');
    const delRow = db.prepare('DELETE FROM media WHERE id = ?');
    const chars = new Set();
    const packs = new Set();

    if (action === 'delete') {
      let done = 0;
      const failed = [];
      const items = [];
      for (const id of ids) {
        const row = getRow.get(id);
        if (!row) continue;
        items.push({ id, path: row.rel_path });
        // 先删文件：文件被占用/权限不足时不要谎报成功，记录留在原处等重试
        const del = await removeLibraryFile(row.rel_path);
        if (!del.ok && !del.alreadyGone) {
          failed.push({ id, reason: whyDeleteFailed(del), code: del.code || null });
          continue;
        }
        delRow.run(id);
        chars.add(row.character_id);
        if (row.pack_id) packs.add(row.pack_id);
        done += 1;
      }
      for (const cid of chars) refreshCharacter(cid);
      for (const pid of packs) refreshPack(pid);
      logOp(db, {
        entity: 'media',
        entityId: ids[0],
        action: 'delete',
        status: failed.length ? 'failed' : 'done',
        reason: failed.length ? `${failed.length} 个文件没删掉` : null,
        payload: { items },
      });
      return res.json({ ok: true, done, skipped: ids.length - done, failed });
    }

    const packId = Number(req.body.packId) || null;
    const pack = packId ? db.prepare('SELECT * FROM packs WHERE id = ?').get(packId) : null;
    if (!pack) return res.status(400).json({ error: '目标图包不存在' });

    let order = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS n FROM media WHERE pack_id = ?').get(pack.id).n;
    const upd = db.prepare('UPDATE media SET pack_id = ?, sort_order = ? WHERE id = ?');
    let done = 0;
    let skipped = 0;
    const movedIds = [];
    for (const id of ids) {
      const row = getRow.get(id);
      // 跨条目移动要搬文件，走 POST /api/packs/:id/media（单个接口）
      if (!row || row.pack_id === pack.id || row.character_id !== pack.character_id) {
        skipped += 1;
        continue;
      }
      order += 1;
      upd.run(pack.id, order, id);
      if (row.pack_id) packs.add(row.pack_id);
      movedIds.push(id);
      done += 1;
    }
    chars.add(pack.character_id);
    packs.add(pack.id);
    for (const pid of packs) refreshPack(pid);
    for (const cid of chars) refreshCharacter(cid);
    if (movedIds.length) {
      logOp(db, {
        entity: 'media',
        entityId: movedIds[0],
        action: 'move',
        status: initialStatus('media.move'),
        payload: { ids: movedIds, toPackId: pack.id, title: pack.title },
      });
    }
    res.json({ ok: true, done, skipped });
  });

  app.get('/api/packs/:id/media', (req, res) => {
    const db = getDb();
    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT character_id, tags FROM packs WHERE id = ?').get(packId);
    const rows = db
      // 漫画按页序读，普通图包保持原顺序（page_no 全是 NULL 时排序键退化成 sort_order）
      .prepare('SELECT * FROM media WHERE pack_id = ? ORDER BY (page_no IS NULL), page_no, sort_order, file_name')
      .all(packId);
    const base = pack ? mediaTagSet(db, pack.character_id) : [];
    // 图包标签下发给包内每张图：标一次全包生效，读时合并所以改了立刻全包同步
    const packTags = pack ? safeJson(pack.tags) : [];
    res.json({
      items: rows.map((r) => ({
        ...mapMedia(r),
        tags: mergeTags(r.tags ? safeJson(r.tags) : [], base, packTags),
      })),
      total: rows.length,
    });
  });

  // ---------- 媒体 ----------

  /**
   * 素材挑选器（「添加到图包」用）。
   * scope: all 全部素材 / character 本角色 / loose 无包 / filed 已归包
   */
  app.get('/api/media/pick', (req, res) => {
    const db = getDb();
    const scope = String(req.query.scope || 'all');
    const charId = Number(req.query.charId) || null;
    const kind = String(req.query.kind || '');
    const q = String(req.query.q || '').trim().slice(0, 60);
    const limit = Math.min(200, Math.max(12, Number(req.query.limit) || 60));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    // 已经在目标图包里的排到后面：一打开就是可选的，不用先滚过一堆「已在包内」
    const pid = Number(req.query.packId) || null;

    // 正文文件不是「素材」，别出现在挑图列表里
    const where = ["m.kind <> 'file'"];
    const params = { limit, offset, pid };
    if (scope === 'character') {
      if (!charId) return res.status(400).json({ error: '缺少角色' });
      where.push('m.character_id = @charId');
      params.charId = charId;
    } else if (scope === 'loose') {
      where.push('m.pack_id IS NULL');
    } else if (scope === 'filed') {
      where.push('m.pack_id IS NOT NULL');
    }
    if (kind === 'image' || kind === 'video') {
      where.push('m.kind = @kind');
      params.kind = kind;
    }
    if (q) {
      // 条目名 / 图包标签也算可搜内容：媒体会继承它们，搜「纸悦」「原神」就该出对应素材
      where.push('(m.file_name LIKE @q OR m.tags LIKE @q OR c.name LIKE @q OR p.tags LIKE @q)');
      params.q = `%${q}%`;
    }
    const clause = where.length ? where.join(' AND ') : '1=1';

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n FROM media m
         LEFT JOIN characters c ON c.id = m.character_id
         LEFT JOIN packs p ON p.id = m.pack_id
         WHERE ${clause}`
      )
      .get(params).n;
    const rows = db
      .prepare(
        `SELECT m.*, c.name AS char_name, sh.kind AS shelf_kind, p.title AS pack_title
         FROM media m
         LEFT JOIN characters c ON c.id = m.character_id
         LEFT JOIN shelves sh ON sh.id = c.shelf_id
         LEFT JOIN packs p ON p.id = m.pack_id
         WHERE ${clause}
         ORDER BY CASE WHEN @pid IS NOT NULL AND m.pack_id = @pid THEN 1 ELSE 0 END, m.id DESC
         LIMIT @limit OFFSET @offset`
      )
      .all(params);

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        fileName: r.file_name,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        durationMs: r.duration_ms,
        packId: r.pack_id,
        packTitle: r.pack_title || '',
        characterId: r.character_id,
        characterName: r.char_name || '',
        shelfKind: r.shelf_kind || 'people',
      })),
      total,
      hasMore: offset + rows.length < total,
    });
  });

  /**
   * 把已有素材加进图包（「从全部/本角色/未分类素材添加」）。
   * 同角色 = 只改分组；跨角色 = 改归属，文件要跟着搬到目标角色的图包目录。
   */
  app.post('/api/packs/:id/media', async (req, res) => {
    const db = getDb();
    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT * FROM packs WHERE id = ?').get(packId);
    if (!pack) return res.status(404).json({ error: '图包不存在' });

    const raw = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ error: '没有选择素材' });
    if (ids.length > 2000) return res.status(400).json({ error: '一次最多添加 2000 个素材' });

    const target = db.prepare('SELECT id, dir_slug FROM characters WHERE id = ?').get(pack.character_id);
    if (!target) return res.status(404).json({ error: '目标角色不存在' });

    const getMedia = db.prepare('SELECT * FROM media WHERE id = ?');
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS n FROM media WHERE pack_id = ?');
    const sameCharMove = db.prepare('UPDATE media SET pack_id = ?, sort_order = ? WHERE id = ?');
    const crossMove = db.prepare(
      'UPDATE media SET character_id = ?, pack_id = ?, rel_path = ?, sort_order = ? WHERE id = ?'
    );
    const dupCheck = db.prepare('SELECT id FROM media WHERE character_id = ? AND sha256 = ?');

    let order = maxOrder.get(packId).n;
    const moved = [];
    const sameMoved = [];   // 同条目：只改库，同步时才搬文件
    const crossDirs = new Set(); // 跨条目：搬完把空掉的源目录交给同步去收
    const skipped = [];
    const warnings = [];
    const touched = new Set([pack.character_id]);

    for (const id of ids) {
      const row = getMedia.get(id);
      if (!row) {
        skipped.push({ id, reason: '素材不存在' });
        continue;
      }
      if (row.pack_id === packId) {
        skipped.push({ id, reason: '已在图包内' });
        continue;
      }

      if (row.character_id === pack.character_id) {
        order += 1;
        sameCharMove.run(packId, order, id);
        moved.push(id);
        sameMoved.push(id);
        continue;
      }

      const dup = dupCheck.get(pack.character_id, row.sha256);
      if (dup) {
        skipped.push({ id, reason: '目标角色已有相同文件' });
        continue;
      }

      /**
       * 跨角色：文件先搬、再写库。
       * - 搬之前落一条意图（journal），进程被杀也能在下次启动时收尾
       * - 写库失败就把文件搬回去；搬不回去记 recovery.log，别把不一致悄悄留下
       */
      crossDirs.add(row.rel_path.split('/').slice(0, -1).join('/'));
      let info = null;
      let dropIntent = null;
      let intentRel = null;
      try {
        const relDir = await resolvePackDir(db, target.dir_slug, pack, row.kind, pack.category);
        info = await relocateFile(row.rel_path, relDir, {
          onTarget: async (absDst) => {
            intentRel = path.relative(DATA_DIR, absDst).split(path.sep).join('/');
            dropIntent = await beginMove({ mediaId: id, fromRel: row.rel_path, toRel: intentRel });
          },
        });
      } catch (err) {
        if (dropIntent) await dropIntent();
        skipped.push({ id, reason: `文件搬迁失败：${err.message || err}` });
        continue;
      }

      try {
        order += 1;
        crossMove.run(pack.character_id, packId, info.relPath, order, id);
      } catch (err) {
        // 数据库没写成 → 把文件搬回原处，保持「操作前」的状态
        let rolled = false;
        try {
          await moveFile(absPathOf(info.relPath), absPathOf(row.rel_path));
          rolled = true;
        } catch (backErr) {
          await logRecovery({
            kind: 'move-rollback-failed',
            mediaId: id,
            fromRel: row.rel_path,
            toRel: info.relPath,
            dbError: String(err.message || err),
            rollbackError: String(backErr.message || backErr),
          });
        }
        if (dropIntent) await dropIntent();
        order -= 1;
        skipped.push({
          id,
          reason: rolled
            ? `数据库写入失败，文件已搬回原处（${err.message || err}）`
            : `数据库写入失败且文件搬不回去（${err.message || err}），已记入 recovery.log`,
          rollback: rolled,
        });
        continue;
      }
      if (dropIntent) await dropIntent();
      touched.add(row.character_id);
      moved.push(id);
      if (info.warning) warnings.push({ id, warning: info.warning });
    }

    refreshPack(packId);
    for (const cid of touched) refreshCharacter(cid);

    if (sameMoved.length) {
      logOp(db, {
        entity: 'media',
        entityId: sameMoved[0],
        action: 'move',
        status: initialStatus('media.move'),
        payload: { ids: sameMoved, toPackId: packId, title: pack.title },
      });
    }
    const sameSet = new Set(sameMoved);
    const crossMoved = moved.filter((id) => !sameSet.has(id));
    if (crossMoved.length) {
      logOp(db, {
        entity: 'media',
        entityId: crossMoved[0],
        action: 'move',
        status: 'done',
        payload: { ids: crossMoved, toPackId: packId, cross: true, title: pack.title },
      });
    }
    const emptyDirs = [...crossDirs].filter((d) => {
      try {
        return fs.readdirSync(absPathOf(d)).length === 0;
      } catch {
        return false;
      }
    });
    if (emptyDirs.length) {
      logOp(db, {
        entity: 'media',
        entityId: null,
        action: 'dir.prune',
        status: initialStatus('dir.prune'),
        payload: { dirs: emptyDirs },
      });
    }
    res.json({ ok: true, moved: moved.length, skipped, warnings, ids: moved });
  });

  /**
   * 移出库：把素材从条目（及其图包）里摘出来，放进「收件箱」的未分类。
   * 和「分发」正好相反，共用同一套搬移保证（journal / 全量 sha256 / 写库失败搬回）。
   * 收件箱里已经有同一份内容时不再留两份：文件只留一份，这条记录直接消失（merged）。
   */
  app.post('/api/media/eject', async (req, res) => {
    const db = getDb();
    const raw = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return res.status(400).json({ error: '没有选择素材' });
    if (ids.length > 2000) return res.status(400).json({ error: '一次最多移出 2000 个素材' });

    const shelf = db.prepare("SELECT * FROM shelves WHERE kind = 'inbox' ORDER BY id LIMIT 1").get();
    if (!shelf) return res.status(400).json({ error: '还没有「收件箱」，先在首页建一个' });
    const box = ensureShelfContainer(shelf.id);
    if (!box) return res.status(400).json({ error: '收件箱没有准备好' });

    const getMedia = db.prepare('SELECT * FROM media WHERE id = ?');
    const moveRow = db.prepare(
      'UPDATE media SET character_id = ?, pack_id = NULL, rel_path = ?, sort_order = ? WHERE id = ?'
    );
    const delRow = db.prepare('DELETE FROM media WHERE id = ?');
    const clearCharCover = db.prepare('UPDATE characters SET cover_media_id = NULL WHERE cover_media_id = ?');
    const clearPackCover = db.prepare('UPDATE packs SET cover_media_id = NULL WHERE cover_media_id = ?');
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS n FROM media WHERE character_id = ?');
    const dirOf = (kind) => `${box.dir_slug}/未分类/${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'}`;

    let order = maxOrder.get(box.id).n;
    const moved = [];
    const merged = [];
    const srcDirs = new Set();
    const skipped = [];
    const warnings = [];
    const chars = new Set();
    const packs = new Set();

    for (const id of ids) {
      const row = getMedia.get(id);
      if (!row) {
        skipped.push({ id, reason: '素材不存在' });
        continue;
      }
      if (row.character_id === box.id) {
        skipped.push({ id, reason: '已经在收件箱里' });
        continue;
      }

      // 收件箱里已经有同一份内容（sha256 是导入时按字节算的）：内容不会丢，
      // 这条记录直接收掉，不再往未分类里塞第二份；旧文件删不掉就整条留着，如实报告
      const dup = row.sha256
        ? db
            .prepare('SELECT id FROM media WHERE character_id = ? AND sha256 = ? AND id <> ?')
            .get(box.id, row.sha256, id)
        : null;
      if (dup) {
        const gone = await removeLibraryFile(row.rel_path);
        if (!gone.ok && !gone.alreadyGone) {
          skipped.push({ id, reason: `收件箱里已有同一份文件，但这份删不掉（${gone.code || gone.error}）` });
          continue;
        }
        srcDirs.add(row.rel_path.split('/').slice(0, -1).join('/'));
        clearCharCover.run(id);
        clearPackCover.run(id);
        delRow.run(id);
        merged.push({ id, path: row.rel_path });
        chars.add(row.character_id);
        if (row.pack_id) packs.add(row.pack_id);
        continue;
      }

      let info = null;
      let dropIntent = null;
      try {
        info = await relocateFile(row.rel_path, dirOf(row.kind), {
          onTarget: async (absDst) => {
            const intentRel = path.relative(DATA_DIR, absDst).split(path.sep).join('/');
            dropIntent = await beginMove({ mediaId: id, fromRel: row.rel_path, toRel: intentRel });
          },
        });
      } catch (err) {
        if (dropIntent) await dropIntent();
        skipped.push({ id, reason: `文件搬迁失败：${err.message || err}` });
        continue;
      }

      try {
        if (info.action === 'reused') {
          // 收件箱里躺着同一份内容（刚比过全量 sha256）：文件不重复存，这条记录收掉
          srcDirs.add(row.rel_path.split('/').slice(0, -1).join('/'));
          clearCharCover.run(id);
          clearPackCover.run(id);
          delRow.run(id);
          merged.push({ id, path: row.rel_path });
        } else {
          order += 1;
          moveRow.run(box.id, info.relPath, order, id);
          clearCharCover.run(id);
          clearPackCover.run(id);
          moved.push(id);
        }
      } catch (err) {
        let rolled = false;
        try {
          await moveFile(absPathOf(info.relPath), absPathOf(row.rel_path));
          rolled = true;
        } catch (backErr) {
          await logRecovery({
            kind: 'eject-rollback-failed',
            mediaId: id,
            fromRel: row.rel_path,
            toRel: info.relPath,
            dbError: String(err.message || err),
            rollbackError: String(backErr.message || backErr),
          });
        }
        if (dropIntent) await dropIntent();
        skipped.push({
          id,
          reason: rolled
            ? `数据库写入失败，文件已搬回原处（${err.message || err}）`
            : `数据库写入失败且文件搬不回去（${err.message || err}），已记入 recovery.log`,
          rollback: rolled,
        });
        continue;
      }
      if (dropIntent) await dropIntent();
      chars.add(row.character_id);
      if (row.pack_id) packs.add(row.pack_id);
      if (info.warning) warnings.push({ id, warning: info.warning });
    }

    for (const pid of packs) refreshPack(pid);
    for (const cid of chars) refreshCharacter(cid);
    refreshCharacter(box.id);
    if (moved.length) {
      logOp(db, {
        entity: 'media',
        entityId: moved[0],
        action: 'move',
        status: 'done',
        payload: { ids: moved, toCharId: box.id, cross: true, title: '移出库' },
      });
    }
    if (merged.length) {
      logOp(db, {
        entity: 'media',
        entityId: merged[0].id,
        action: 'delete',
        reason: '收件箱已有同一份内容，合并',
        payload: { items: merged },
      });
    }
    const emptySrcDirs = [...srcDirs].filter((d) => {
      try {
        return fs.readdirSync(absPathOf(d)).length === 0;
      } catch {
        return false;
      }
    });
    if (emptySrcDirs.length) {
      logOp(db, {
        entity: 'media',
        entityId: null,
        action: 'dir.prune',
        status: initialStatus('dir.prune'),
        payload: { dirs: emptySrcDirs },
      });
    }
    res.json({ ok: true, moved: moved.length, merged: merged.length, shelfId: shelf.id, skipped, warnings, ids: moved });
  });

  app.get('/api/characters/:id/media', (req, res) => {
    const db = getDb();
    const charId = Number(req.params.id);
    const kind = String(req.query.kind || '').trim();
    // 正文文件（txt / epub）在详情页有独立的「正文」列表，不进图片瀑布流
    const where = ["character_id = @charId", "kind <> 'file'"];
    const params = { charId };
    if (kind === 'image' || kind === 'video') {
      where.push('kind = @kind');
      params.kind = kind;
    }
    const rows = db
      .prepare(`SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY sort_order DESC, id DESC`)
      .all(params);
    const base = mediaTagSet(db, charId);
    const packTags = packTagMap(db, charId);
    res.json({
      items: rows.map((r) => ({
        ...mapMedia(r),
        tags: mergeTags(
          r.tags ? safeJson(r.tags) : [],
          base,
          packTags ? packTags.get(r.pack_id) : []
        ),
      })),
      total: rows.length,
    });
  });

/**
 * 库里这条记录对应的文件还在，并且字节数和入库时一致。
 * 压缩包要删源之前，靠它确认「重复文件」不是一条悬空记录。
 */
function libraryCopyOk(relPath, bytes) {
  try {
    const st = fs.statSync(absPathOf(relPath));
    return st.isFile() && Number(st.size) === Number(bytes);
  } catch {
    return false;
  }
}

/**
 * 这批新写入的媒体，磁盘上的副本是不是都在、大小是不是和记录一致。
 * 对不上的不能算「已经安全入库」。
 */
function unverifiedAdds(db, ids) {
  const get = db.prepare('SELECT file_name, rel_path, bytes FROM media WHERE id = ?');
  const bad = [];
  for (const id of ids || []) {
    const row = get.get(id);
    if (!row) {
      bad.push({ name: `#${id}`, reason: '入库记录没有写上' });
      continue;
    }
    if (!libraryCopyOk(row.rel_path, row.bytes)) {
      bad.push({ name: row.file_name, reason: '库内副本不在磁盘上或大小不符' });
    }
  }
  return bad;
}

/**
 * 压缩包能不能删掉。
 *
 * 每一张图片 / 视频都要有着落：要么这次新写入且磁盘副本核对过，
 * 要么跳过的原因正好是「重复文件」（库里已有一份核对过的相同内容）。
 * 解压有跳过、读写失败、数量对不上，都不许删 —— 源包留在原地。
 */
function archiveMayDelete({ mediaCount, addedIds, ingestSkipped, extractSkipped, verifiedBad }) {
  const failures = [];
  for (const s of extractSkipped || []) {
    failures.push({ name: s.name || '', reason: s.reason || '解压失败' });
  }
  for (const s of ingestSkipped || []) {
    if (s.reason === '重复文件') continue;
    failures.push({ name: s.name || '', reason: s.reason || '导入失败' });
  }
  for (const s of verifiedBad || []) failures.push(s);
  const dup = (ingestSkipped || []).filter((s) => s.reason === '重复文件').length;
  const added = (addedIds || []).length;
  if (mediaCount > 0 && added + dup !== mediaCount && !failures.length) {
    failures.push({
      name: '',
      reason: `解出 ${mediaCount} 个图片或视频，只确认了 ${added + dup} 个`,
    });
  }
  return { ok: mediaCount > 0 && failures.length === 0 && added + dup === mediaCount, failures };
}

/**
   * 把一批「已经落在临时目录里」的文件收进条目。
   *
   * 上传（multer 先落到 .cache/inbox）和解压（落到 .cache/unzip-*）走同一条链路：
   * 算 sha 查重 → 定图包 / 目录 → adoptFile 落盘 → 插 media → 排队生成缩略图。
   * files: [{ path, name }]，path 必须是本次请求自己的临时文件（会被删）。
   */
  async function ingestFiles(db, char, shelfKind, files, { forcedPackId = null, category = null } = {}) {
    const charId = char.id;
    const added = [];
    const skipped = [];
    /** 本次真正写入了媒体的图包。只刷新这几个包的封面就够了 */
    const touchedPacks = new Set();

    for (const f of files) {
      const originalName = f.name;
      const drop = () => fsp.unlink(f.path).catch(() => {});
      const kind = kindOfExt(path.extname(originalName).toLowerCase());
      if (!kind) {
        await drop();
        skipped.push({ name: originalName, reason: '不支持的文件类型' });
        continue;
      }
      // 正文文件只有小说库收：别的库里放 txt / pdf 只会变成一堆打不开的条目
      if (kind === 'file' && shelfKind !== 'novel') {
        await drop();
        skipped.push({ name: originalName, reason: '正文文件只能放进小说库' });
        continue;
      }

      // 先算哈希查重：重复文件不该再跨盘复制一遍（机械盘上这一步很贵）
      let sha;
      try {
        sha = await hashFileOf(f.path);
      } catch (err) {
        await drop();
        skipped.push({ name: originalName, reason: `读取失败：${err.code || err.message}` });
        continue;
      }
      const existing = db
        .prepare('SELECT id, rel_path, bytes FROM media WHERE character_id = ? AND sha256 = ?')
        .get(charId, sha);
      // 「重复」必须是磁盘上那份还在、大小也对得上。只有一条记录、文件已经丢了，
      // 不能当成已经入库 —— 否则压缩包会在源被删掉之后再也补不回来。
      if (existing && libraryCopyOk(existing.rel_path, existing.bytes)) {
        await drop();
        skipped.push({ name: originalName, reason: '重复文件' });
        continue;
      }

      // 先定图包，才知道文件该进哪个目录
      const isDoc = kind === 'file';
      const month = monthOfFileName(originalName);
      // 表情包没有「按日期归包」：不指定图包就直接落到未分类
      const pack = isDoc
        ? null
        : forcedPackId
          ? db.prepare('SELECT id, title, category, kind FROM packs WHERE id = ?').get(forcedPackId)
          : char.is_container
            ? // 散图集只有「图包 / 全部素材」两栏，落下就走未分类等于看不见；
              // 所以按文件名月份自动建包（和普通条目一样），文件始终有归属
              shelfKind === 'loose'
              ? ensurePackFor(db, charId, month || currentMonth(), category)
              : null
            : ensurePackFor(db, charId, month, category);
      if (!isDoc && forcedPackId && !pack) {
        await drop();
        skipped.push({ name: originalName, reason: '图包不存在' });
        continue;
      }

      // 正文文件不属于任何图包：<库>/<书>/未分类/文件
      const relDir = isDoc
        ? `${char.dir_slug}/未分类/文件`
        : pack
          ? await resolvePackDir(db, char.dir_slug, pack, kind, pack.category || category)
          : `${char.dir_slug}/未分类/${kind === 'image' ? '图片' : '视频'}`;

      let saved;
      try {
        saved = await adoptFile(f.path, relDir, originalName, sha);
      } catch (err) {
        await drop();
        skipped.push({ name: originalName, reason: `写入失败：${err.code || err.message}` });
        continue;
      }
      if (!saved) {
        await drop();
        skipped.push({ name: originalName, reason: '不支持的文件类型' });
        continue;
      }

      // 漫画包：新图接在最后一页后面，别打乱已有页序
      const pageNo =
        pack && pack.kind === 'comic'
          ? db.prepare('SELECT COALESCE(MAX(page_no),0)+1 AS n FROM media WHERE pack_id = ?').get(pack.id).n
          : null;
      const info = db
        .prepare(
          `INSERT INTO media(character_id, pack_id, kind, rel_path, file_name, ext, bytes, sha256, width, height, anim, sort_order, page_no, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,
             (SELECT COALESCE(MAX(sort_order),-1)+1 FROM media WHERE pack_id IS ?),?,?)`
        )
        .run(
          charId,
          pack ? pack.id : null,
          kind,
          saved.relPath,
          originalName,
          saved.ext,
          saved.bytes,
          saved.sha256,
          saved.width,
          saved.height,
          saved.anim ? 1 : 0,
          pack ? pack.id : null,
          pageNo,
          nowIso()
        );
      const newId = Number(info.lastInsertRowid);
      added.push(newId);
      if (pack) touchedPacks.add(pack.id);
      // 正文文件没有缩略图，别往生成池里塞无解的活
      if (kind !== 'file') getDerivative(newId, 'thumb').catch(() => {});
      // 入库成功：临时区那份「源文件」已经 moveFile 移走/复制完，
      // 这里再补一刀 —— 跨盘复制后删源失败、或上面任何分支提前 continue，
      // 都不该把副本留在 .cache/inbox 里（曾经堆了 500MB / 582 个文件）
      await drop();
    }

    // 万一某个文件在中途抛异常，循环外也清一次本次请求剩下的临时文件
    await Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => {})));

    for (const pid of touchedPacks) refreshPack(pid);
    refreshCharacterSoon(charId);
    return { added, skipped };
  }

  app.post('/api/characters/:id/media', upload.array('files', 400), async (req, res) => {
    const db = getDb();
    const charId = Number(req.params.id);
    const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '没有收到文件' });

    const forcedPackId = req.body && req.body.packId ? Number(req.body.packId) : null;
    const category = String((req.body && req.body.category) || '').trim().slice(0, 20) || null;
    const shelfRow = db.prepare('SELECT kind FROM shelves WHERE id = ?').get(char.shelf_id);
    const shelfKind = (shelfRow && shelfRow.kind) || '';

    // 压缩包本该走 /archive；如果它出现在这里，说明前端把它当成了图片 / 视频 ——
    // 表现就是「上传结束，N 个跳过」，日志里留个现场，别再让它变成悬案
    const strays = files.map((f) => decodeName(f.originalname)).filter((n) => isArchiveName(n));
    if (strays.length) {
      logArchiveAttempt({ via: 'media', stage: 'wrong-route', names: strays.slice(0, 5), charId });
    }

    const out = await ingestFiles(
      db,
      char,
      shelfKind,
      files.map((f) => ({ path: f.path, name: decodeName(f.originalname) })),
      { forcedPackId, category }
    );
    if (out.added.length) {
      logOp(db, {
        entity: 'media',
        entityId: out.added[0],
        action: 'add',
        payload: { ids: out.added, charId, packId: forcedPackId, category },
      });
    }
    res.json({ added: out.added.length, skipped: out.skipped, ids: out.added });
  });

  /**
   * 压缩包 → 散图：解压后走和上传完全相同的入库链路。
   *
   * 拖到某个图包里（带 packId）就进那个图包；拖到条目 / 库首页（不带 packId）
   * 就按压缩包名新建一个图包（同名图包已存在时直接复用，避免反复拖同一个包长出一堆重名包）。
   * 「素材」是收件箱，没有图包概念，解出来的直接落未分类。
   */
  app.post('/api/characters/:id/archive', upload.single('archive'), async (req, res) => {
    const db = getDb();
    const charId = Number(req.params.id);
    const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    const tmpArchive = req.file ? req.file.path : null;
    let archivePath = tmpArchive;
    let workDir = null;
    // 没全部入库时置上：cleanup 只清解压目录，不删压缩包本身
    let preserveArchive = false;
    const cleanup = async () => {
      if (workDir) await fsp.rm(workDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      if (preserveArchive) return;
      if (tmpArchive) await fsp.unlink(tmpArchive).catch(() => {});
      if (archivePath && archivePath !== tmpArchive) await fsp.unlink(archivePath).catch(() => {});
    };
    /**
     * 解压失败时把压缩包留下来（挪到 .cache/failed/）。
     * 以前失败也照删 —— 用户那边源文件早删了的话，就只剩「重新下载」一条路。
     * 但用户重试成功之后这份就成垃圾了，所以顺手做一次清理：只留最近 3 个、总量不超过 300MB。
     */
    const pruneFailed = async () => {
      const dir = path.join(CACHE_DIR, 'failed');
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        return;
      }
      const stats = [];
      for (const n of names) {
        try {
          const st = await fsp.stat(path.join(dir, n));
          stats.push({ n, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* 已被别的请求清理掉 */
        }
      }
      stats.sort((a, b) => b.mtime - a.mtime);
      let kept = 0;
      let bytes = 0;
      for (const s of stats) {
        kept += 1;
        bytes += s.size;
        if (kept > 3 || bytes > 300 * 1024 ** 2) {
          await fsp.unlink(path.join(dir, s.n)).catch(() => {});
        }
      }
    };
    const keepArchive = async () => {
      if (!archivePath) return null;
      const dir = path.join(CACHE_DIR, 'failed');
      try {
        await fsp.mkdir(dir, { recursive: true });
        const dest = path.join(dir, `${Date.now()}-${path.basename(archivePath)}`);
        await fsp.rename(archivePath, dest);
        archivePath = null;
        await pruneFailed();
        return dest;
      } catch {
        return null;
      }
    };

    try {
      if (!char) {
        await cleanup();
        return res.status(404).json({ error: '角色不存在' });
      }
      if (!req.file) return res.status(400).json({ error: '没有收到压缩包' });

      const originalName = decodeName(req.file.originalname);
      logArchiveAttempt({ via: 'upload', name: originalName, bytes: req.file.size, password: !!(req.body && req.body.password), stage: 'received' });
      if (!isArchiveName(originalName)) {
        logArchiveAttempt({ via: 'upload', name: originalName, stage: 'reject', code: 'NOT_ARCHIVE' });
        await cleanup();
        return res.status(400).json({ error: '只支持 zip / rar / 7z / tar / tar.gz 压缩包' });
      }

      const forcedPackId = req.body && req.body.packId ? Number(req.body.packId) : null;
      const category = String((req.body && req.body.category) || '').trim().slice(0, 20) || null;
      const shelfRow = db.prepare('SELECT kind FROM shelves WHERE id = ?').get(char.shelf_id);
      const shelfKind = (shelfRow && shelfRow.kind) || '';

      workDir = await fsp.mkdtemp(path.join(CACHE_DIR, 'unzip-'));
      // multer 落的是无扩展名的随机名，而 UnRAR 之类会「按扩展名找文件」直接报
      // 「找不到 xxx.rar」—— 解压前先把原扩展名补上
      const ext = path.extname(originalName).toLowerCase();
      if (/^\.[a-z0-9]{1,5}$/.test(ext)) {
        const withExt = `${archivePath}${ext}`;
        try {
          await fsp.rename(archivePath, withExt);
          archivePath = withExt;
        } catch {
          /* 改名失败就用原路径，zip 自己认魔数不受影响 */
        }
      }

      let packed;
      try {
        packed = await extractArchive(archivePath, workDir, {
          password: String((req.body && req.body.password) || '').slice(0, 128),
        });
      } catch (err) {
        logArchiveAttempt({
          via: 'upload',
          name: originalName,
          stage: 'extract',
          code: err.code || 'ARCHIVE_FAILED',
          error: err.message || '解压失败',
        });
        preserveArchive = true;
        const kept = await keepArchive();
        await cleanup();
        return res.status(400).json({
          error: err.message || '解压失败',
          code: err.code || 'ARCHIVE_FAILED',
          keptArchive: kept,
        });
      }

      // 只要图片 / 视频：压缩包里通常还有 readme、种子、网址快捷方式
      const media = packed.files.filter((f) => ['image', 'video'].includes(kindOfExt(path.extname(f.name))));
      if (!media.length) {
        logArchiveAttempt({
          via: 'upload',
          name: originalName,
          stage: 'filter',
          format: packed.format,
          tool: packed.tool || null,
          entries: packed.files.length,
          media: 0,
          sample: packed.files.slice(0, 8).map((f) => f.name),
          code: 'NO_MEDIA',
        });
        preserveArchive = true;
        const kept = await keepArchive();
        await cleanup();
        return res.status(400).json({
          error: `压缩包里有 ${packed.files.length} 个文件，但没有图片或视频`,
          failures: (packed.skipped || []).map((s) => ({ name: s.name, reason: s.reason || '解压失败' })),
          keptArchive: kept,
          sourceKept: true,
        });
      }

      let pack = null;
      let created = false;
      if (forcedPackId) {
        pack = db.prepare('SELECT id, title, kind FROM packs WHERE id = ? AND character_id = ?').get(forcedPackId, charId);
        if (!pack) {
          preserveArchive = true;
          const kept = await keepArchive();
          await cleanup();
          return res.status(404).json({ error: '图包不存在', keptArchive: kept, sourceKept: true });
        }
      } else if (!char.is_container || shelfKind === 'loose') {
        pack = ensureNamedPack(db, charId, titleFromArchive(originalName), category);
        created = !!pack.created;
      }

      const out = await ingestFiles(
        db,
        char,
        shelfKind,
        media.map((f) => ({ path: f.abs, name: f.name })),
        { forcedPackId: pack ? pack.id : null, category }
      );

      // 刚建的包一个文件都没进（全是重复内容）→ 删掉，别在列表里留一个「0 项」的空壳
      if (pack && created && !out.added.length) {
        db.prepare('DELETE FROM packs WHERE id = ?').run(pack.id);
        pack = null;
        refreshCharacter(charId); // ingestFiles 里刚统计过，这里把包数改回来
      }

      if (out.added.length) {
        logOp(db, {
          entity: 'media',
          entityId: out.added[0],
          action: 'add',
          payload: {
            ids: out.added,
            charId,
            packId: pack ? pack.id : null,
            archive: req.file ? req.file.originalname : '',
          },
        });
      }
      const decision = archiveMayDelete({
        mediaCount: media.length,
        addedIds: out.added,
        ingestSkipped: out.skipped,
        extractSkipped: packed.skipped,
        verifiedBad: unverifiedAdds(db, out.added),
      });
      logArchiveAttempt({
        via: 'upload',
        name: originalName,
        stage: decision.ok ? 'done' : 'partial',
        format: packed.format,
        tool: packed.tool || null,
        entries: packed.files.length,
        media: media.length,
        added: out.added.length,
        skipped: out.skipped.length,
        failures: decision.failures.length,
        packId: pack ? pack.id : null,
      });
      const summary = {
        added: out.added.length,
        ids: out.added,
        skipped: [
          ...packed.skipped.map((s) => ({ name: s.name, reason: s.reason })),
          ...out.skipped,
          ...decision.failures.filter((f) => f.reason === '库内副本不在磁盘上或大小不符' || f.reason === '入库记录没有写上'),
        ],
        failures: decision.failures,
        sourceKept: !decision.ok,
        pack: pack ? { id: pack.id, title: pack.title, created } : null,
        format: packed.format,
        tool: packed.tool || null,
        entries: packed.files.length,
      };
      // 浏览器这条没有用户磁盘上的路径，multer 的临时包就是唯一副本。
      // 没全部入库就挪到 .cache/failed 留着，别在清理解压目录时把它一起删掉。
      if (!decision.ok) {
        preserveArchive = true;
        summary.keptArchive = await keepArchive();
      }
      await cleanup();
      res.json(summary);
    } catch (err) {
      preserveArchive = true;
      const kept = await keepArchive();
      await cleanup();
      console.error('[archive] 解压导入失败', err);
      res.status(500).json({ error: `解压导入失败：${err.message || err}`, keptArchive: kept, sourceKept: true });
    }
  });

  /** 单个媒体详情（详情页用）：带上所属条目 / 图包 / 库，标签是含继承的完整集合 */
  app.get('/api/media/:id', (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT m.*, c.name AS char_name, c.is_container, sh.id AS shelf_id, sh.name AS shelf_name, sh.kind AS shelf_kind,
                p.title AS pack_title, p.month AS pack_month, p.category AS pack_category
         FROM media m
         JOIN characters c ON c.id = m.character_id
         LEFT JOIN shelves sh ON sh.id = c.shelf_id
         LEFT JOIN packs p ON p.id = m.pack_id
         WHERE m.id = ?`
      )
      .get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '媒体不存在' });

    const base = mediaTagSet(db, row.character_id);
    const own = safeJson(row.tags);
    // 图包标签算继承标签，详情页要能看到（所有库一致）
    const packRow = row.pack_id ? db.prepare('SELECT tags FROM packs WHERE id = ?').get(row.pack_id) : null;
    const inheritedPackTags = packRow ? safeJson(packRow.tags) : [];
    res.json({
      ...mapMedia(row),
      tags: mergeTags(own, base, inheritedPackTags),
      ownTags: own,
      // 来自图包的标签（前端据此区分「去图包上改」还是「去条目上改」）
      packTags: inheritedPackTags,
      intro: row.intro || '',
      createdAt: row.created_at,
      thumb: `/t/${row.id}`,
      preview: `/pv/${row.id}`,
      original: `/m/${row.id}`,
      pack: row.pack_id
        ? { id: row.pack_id, title: row.pack_title, month: row.pack_month, category: row.pack_category }
        : null,
      character: { id: row.character_id, name: row.char_name, container: !!row.is_container },
      shelf: { id: row.shelf_id, name: row.shelf_name || '', kind: row.shelf_kind || 'people' },
    });
  });

  app.patch('/api/media/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '媒体不存在' });
    const b = req.body || {};
    if (b.packId !== undefined) {
      const pid = b.packId === null ? null : Number(b.packId);
      db.prepare('UPDATE media SET pack_id = ? WHERE id = ?').run(pid, id);
      refreshPack(row.pack_id);
      if (pid) refreshPack(pid);
      if (pid !== row.pack_id) {
        logOp(db, {
          entity: 'media',
          entityId: id,
          action: 'move',
          status: initialStatus('media.move'),
          payload: { ids: [id], toPackId: pid, fromPackId: row.pack_id },
        });
      }
    }
    if (typeof b.sortOrder === 'number') {
      db.prepare('UPDATE media SET sort_order = ? WHERE id = ?').run(b.sortOrder, id);
    }
    if (typeof b.fileName === 'string' && b.fileName.trim()) {
      // 只改库里的显示名，磁盘文件名保持不动（磁盘名带 sha 前缀，是去重依据）
      const keepExt = row.ext && !b.fileName.toLowerCase().endsWith(row.ext) ? row.ext : '';
      db.prepare('UPDATE media SET file_name = ? WHERE id = ?').run(
        (b.fileName.trim() + keepExt).slice(0, 160),
        id
      );
    }
    if (Array.isArray(b.tags)) {
      db.prepare('UPDATE media SET tags = ? WHERE id = ?').run(
        JSON.stringify(cleanTags(b.tags)),
        id
      );
    }
    if (typeof b.intro === 'string') {
      db.prepare('UPDATE media SET intro = ? WHERE id = ?').run(b.intro.slice(0, 600), id);
    }
    refreshCharacter(row.character_id);
    res.json({ ok: true });
  });

  app.delete('/api/media/:id', async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '媒体不存在' });
    // 先删文件：删不掉就返回 409 并保留记录，用户还能看见它、重试一次
    const del = await removeLibraryFile(row.rel_path);
    if (!del.ok && !del.alreadyGone) {
      logOp(db, {
        entity: 'media',
        entityId: row.id,
        action: 'delete',
        status: 'failed',
        reason: whyDeleteFailed(del),
        payload: { items: [{ id: row.id, path: row.rel_path }] },
      });
      return res.status(409).json({
        error: `文件删不掉：${whyDeleteFailed(del)}`,
        code: del.code || null,
        path: del.path || null,
      });
    }
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    refreshPack(row.pack_id);
    refreshCharacter(row.character_id);
    logOp(db, {
      entity: 'media',
      entityId: row.id,
      action: 'delete',
      payload: { items: [{ id: row.id, path: row.rel_path }] },
    });
    res.json({ ok: true });
  });

  /**
   * 视频封面：抽当前这一帧当缩略图。
   * 只影响这一条媒体的缩略图（/t/:id），所以图包封面、条目封面、
   * 列表瓦片只要用的是同一个 id，都会跟着变。
   */
  app.post('/api/media/:id/poster', async (req, res) => {
    const r = await capturePoster(Number(req.params.id), (req.body || {}).at);
    res.json({ ok: true, ...r, thumb: `/t/${Number(req.params.id)}` });
  });

  // 恢复默认封面：删掉抽出来的那一帧，回落到自动首帧
  app.delete('/api/media/:id/poster', async (req, res) => {
    await clearPoster(Number(req.params.id));
    res.json({ ok: true, thumb: `/t/${Number(req.params.id)}` });
  });

  // ---------- 派生图与原文件 ----------
  // 注意：缓存放在 .catalog 下，send 库默认拒绝 dotfile，必须显式 dotfiles:'allow'
  app.get('/t/:id', async (req, res) => {
    try {
      const p = await getDerivative(Number(req.params.id), 'thumb');
      if (!p) return res.status(404).end();
      /* 视频缩略图不能 immutable：封面可以从任意一帧重设，URL 却一直是 /t/:id。
         immutable 一旦落到浏览器里，换封面后它根本不会再来问服务器 —— 列表、
         图包封面、角色封面就会一直显示旧的那一帧。
         no-cache = 可以存，但每次用之前必须带 ETag 回来问一次，没变就是 304。 */
      const kind = getDb().prepare('SELECT kind FROM media WHERE id = ?').get(Number(req.params.id));
      res.set('Cache-Control', kind && kind.kind === 'video' ? 'no-cache' : 'public, max-age=31536000, immutable');
      res.sendFile(p, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.get('/pv/:id', async (req, res) => {
    try {
      const p = await getDerivative(Number(req.params.id), 'preview');
      if (!p) return res.status(404).end();
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(p, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });

  /**
   * 正文文件原样下发（txt / epub / pdf …）。
   * inline 给浏览器直接打开（txt 阅读器 fetch 成字节流自己判编码），
   * ?download=1 则当附件下载。sendFile 自带 Range，PDF 翻页不会整个重下。
   */
  app.get('/api/media/:id/raw', (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).end();
    const abs = absPathOf(row.rel_path);
    if (!fs.existsSync(abs)) return res.status(410).json({ error: '文件已丢失', path: row.rel_path });
    const inline = String(req.query.download || '') !== '1';
    res.set('Content-Type', MIME[row.ext] || 'application/octet-stream');
    // 正文文件随时可能被替换成同名新版本，别让浏览器吃旧缓存
    res.set('Cache-Control', 'no-cache');
    res.set(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`
    );
    res.sendFile(abs, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.get('/m/:id', (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).end();
    const abs = absPathOf(row.rel_path);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return res.status(410).json({ error: '文件已丢失', path: row.rel_path });
    }
    const type = MIME[row.ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) return res.status(416).end();
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start >= stat.size) {
        return res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
      }
      end = Math.min(end, stat.size - 1);
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': type,
      });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.set({ 'Content-Length': String(stat.size), 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(abs).pipe(res);
    }
  });

  app.post('/api/warm', (req, res) => {
    warmAll({ size: 'thumb' });
    res.json({ ok: true });
  });

  app.get('/api/tasks', (req, res) => res.json({ warm: warmState }));

  /**
   * 从本机绝对路径导入（只给桌面壳用）。
   *
   * 浏览器拖拽只给字节、不给路径；壳的 drop 事件拿得到真实路径 ——
   * 这是「导入完把源文件删掉」的唯一合法入口。
   * body: { paths: string[], charId, packId?, category?, password?, move?: boolean }
   */
  app.post('/api/import/paths', async (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const paths = (Array.isArray(b.paths) ? b.paths : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    if (!paths.length) return res.status(400).json({ error: '没有收到路径' });

    const charId = Number(b.charId);
    const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });

    const forcedPackId = b.packId ? Number(b.packId) : null;
    const category = String(b.category || '').trim().slice(0, 20) || null;
    const password = String(b.password || '').slice(0, 128);
    // 桌面壳拖进来的压缩包不会弹密码框（那条链路是「路径导入」，没有上传队列的 UI）。
    // 所以前端把本机记住过的密码整串带过来，服务端逐个试 —— 试对了零交互。
    const savedPasswords = (Array.isArray(b.passwords) ? b.passwords : [])
      .map((x) => String(x || '').slice(0, 128))
      .filter(Boolean);
    let usedPassword = '';
    const move = b.move !== false;
    const shelfRow = db.prepare('SELECT kind FROM shelves WHERE id = ?').get(char.shelf_id);
    const shelfKind = (shelfRow && shelfRow.kind) || '';

    const added = [];
    const skipped = [];
    const removed = [];
    const kept = [];
    const failures = [];
    const workDirs = [];

    const tmpName = (ext) => `import-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`;

    const collectMedia = async (dir) => {
      const out = [];
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (['image', 'video'].includes(kindOfExt(path.extname(e.name)))) out.push(full);
        }
      }
      return out.sort((x, y) =>
        path.basename(x).localeCompare(path.basename(y), 'zh-Hans-CN', { numeric: true })
      );
    };

    /** 库里确实有这份内容（记录 + 实体文件都在），才允许删源 */
    const libHasCopy = async (abs) => {
      try {
        const sha = await hashFileOf(abs);
        const row = db
          .prepare('SELECT rel_path FROM media WHERE character_id = ? AND sha256 = ?')
          .get(charId, sha);
        return !!(row && fs.existsSync(absPathOf(row.rel_path)));
      } catch {
        return false;
      }
    };

    try {
      for (const raw of paths) {
        const abs = path.resolve(raw);
        let st;
        try {
          st = await fsp.stat(abs);
        } catch {
          skipped.push({ name: raw, reason: '路径不存在' });
          continue;
        }

        let batch = [];
        let packForThis = forcedPackId;
        let archiveName = '';
        let packed = null;
        let media = [];

        if (st.isDirectory()) {
          const files = await collectMedia(abs);
          if (!files.length) {
            skipped.push({ name: path.basename(abs), reason: '目录里没有图片或视频' });
            continue;
          }
          await fsp.mkdir(INBOX_DIR, { recursive: true });
          for (const f of files) {
            const tmp = path.join(INBOX_DIR, tmpName(path.extname(f)));
            await fsp.copyFile(f, tmp);
            batch.push({ path: tmp, name: path.basename(f) });
          }
        } else if (isArchiveName(path.basename(abs))) {
          const tries = [...new Set([password, ...savedPasswords].filter(Boolean))];
          let lastErr = null;
          for (const pw of tries.length ? tries : ['']) {
            // 每次都用新目录：密码错了会写出一堆解坏的半成品，不能复用
            const workDir = await fsp.mkdtemp(path.join(CACHE_DIR, 'unzip-'));
            workDirs.push(workDir);
            try {
              packed = await extractArchive(abs, workDir, { password: pw });
              if (pw) usedPassword = pw;
              lastErr = null;
              break;
            } catch (err) {
              lastErr = err;
              // 只有「密码不对 / 没密码」才值得换下一个密码试
              if (err.code !== 'NEED_PASSWORD' && err.code !== 'BAD_PASSWORD') break;
            }
          }
          logArchiveAttempt({
            via: 'path',
            name: path.basename(abs),
            bytes: st.size,
            stage: packed ? 'done' : 'extract',
            tried: tries.filter(Boolean).length,
            code: packed ? 'OK' : (lastErr && lastErr.code) || 'ARCHIVE_FAILED',
            error: packed ? undefined : lastErr && lastErr.message,
          });
          if (!packed) {
            // 要密码 / 密码全错：整包失败，交给前端弹窗问一次
            if (lastErr && ['NEED_PASSWORD', 'BAD_PASSWORD', 'ZIP_AES'].includes(lastErr.code)) {
              const err = new Error(lastErr.message || '压缩包需要密码');
              err.status = 400;
              err.code = lastErr.code;
              err.archiveName = path.basename(abs);
              err.tried = tries.filter(Boolean).length;
              throw err;
            }
            skipped.push({
              name: path.basename(abs),
              reason: (lastErr && lastErr.message) || '解压失败',
              code: lastErr && lastErr.code,
            });
            continue;
          }
          archiveName = path.basename(abs);
          media = packed.files.filter((f) =>
            ['image', 'video'].includes(kindOfExt(path.extname(f.name)))
          );
          if (!media.length) {
            for (const s of packed.skipped || []) {
              skipped.push({ name: s.name, reason: s.reason || '解压失败' });
            }
            skipped.push({ name: archiveName, reason: `解出 ${packed.files.length} 个文件，没有图片或视频` });
            if (move) kept.push(abs);
            continue;
          }
          batch = media.map((f) => ({ path: f.abs, name: f.name }));
        } else {
          const kind = kindOfExt(path.extname(abs));
          if (!kind || kind === 'file') {
            skipped.push({ name: path.basename(abs), reason: '不支持的文件类型' });
            continue;
          }
          await fsp.mkdir(INBOX_DIR, { recursive: true });
          const tmp = path.join(INBOX_DIR, tmpName(path.extname(abs)));
          await fsp.copyFile(abs, tmp);
          batch = [{ path: tmp, name: path.basename(abs) }];
        }

        // 压缩包且没指定图包 → 按包名建一个（和网页拖拽同一套规则）
        if (archiveName && !packForThis && (!char.is_container || shelfKind === 'loose')) {
          packForThis = ensureNamedPack(db, charId, titleFromArchive(archiveName), category).id;
        }

        const out = await ingestFiles(db, char, shelfKind, batch, {
          forcedPackId: packForThis,
          category,
        });
        added.push(...out.added);
        skipped.push(...out.skipped);

        if (!move) continue;

        if (st.isDirectory()) {
          let gone = 0;
          const files = await collectMedia(abs);
          for (const f of files) {
            if (await libHasCopy(f)) {
              await fsp.unlink(f).catch(() => {});
              gone += 1;
            } else {
              kept.push(f);
            }
          }
          removed.push(`${path.basename(abs)}/ (${gone}/${files.length})`);
        } else if (archiveName) {
          // 源包留在用户拖进来的那个路径，失败时不挪走。
          // 只有每张图片/视频都已在库里（新写入并核对过，或因相同内容跳过）才删。
          const decision = archiveMayDelete({
            mediaCount: media.length,
            addedIds: out.added,
            ingestSkipped: out.skipped,
            extractSkipped: packed.skipped,
            verifiedBad: unverifiedAdds(db, out.added),
          });
          for (const f of decision.failures) {
            if (!skipped.some((s) => s.name === f.name && s.reason === f.reason)) skipped.push(f);
          }
          failures.push(...decision.failures.map((f) => ({ archive: archiveName, ...f })));
          if (decision.ok) {
            await fsp
              .unlink(abs)
              .then(() => removed.push(abs))
              .catch(() => kept.push(abs));
          } else {
            kept.push(abs);
          }
        } else if (await libHasCopy(abs)) {
          await fsp
            .unlink(abs)
            .then(() => removed.push(abs))
            .catch(() => kept.push(abs));
        } else {
          kept.push(abs);
        }
      }

      if (added.length) {
        logOp(db, {
          entity: 'media',
          entityId: added[0],
          action: 'add',
          source: 'shell',
          payload: { ids: added, charId, packId: forcedPackId },
        });
      }
      logArchiveAttempt({
        via: 'path',
        stage: 'summary',
        charId,
        packId: forcedPackId,
        added: added.length,
        skipped: skipped.length,
        removed: removed.length,
        kept: kept.length,
        failures: failures.length,
      });
      res.json({ added: added.length, ids: added, skipped, removed, kept, failures, passwordUsed: usedPassword });
    } catch (err) {
      // 密码类的错误要有自己的形状：前端靠 code 决定「弹窗问密码」还是「直接报错」
      if (err && ['NEED_PASSWORD', 'BAD_PASSWORD', 'ZIP_AES'].includes(err.code)) {
        return res.status(400).json({
          error: err.message,
          code: err.code,
          archiveName: err.archiveName || null,
          tried: err.tried || 0,
        });
      }
      throw err;
    } finally {
      await Promise.all(
        workDirs.map((d) => fsp.rm(d, { recursive: true, force: true, maxRetries: 2 }).catch(() => {}))
      );
    }
  });

  /**
   * 优雅退出，只给桌面壳用。
   *
   * 壳关窗口时如果直接 TerminateProcess，SQLite 的 WAL 有可能停在 checkpoint 中间：
   * 实测「刚导入的 69 条记录」在下一次启动后凭空消失（WAL 被截成 0 字节、主库没写完）。
   * 这里让服务自己把 WAL 落盘再 exit，壳那边关了窗口等 600ms 才 kill。
   */
  app.post('/api/shutdown', (req, res) => {
    const ip = String(req.ip || '');
    if (!ip.includes('127.0.0.1')) return res.status(403).json({ error: '只允许本机调用' });
    res.json({ ok: true });
    setTimeout(() => {
      try {
        getDb().pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* 库可能已经关了，退出优先 */
      }
      process.exit(0);
    }, 120);
  });

  // 兜底：不带版本前缀的请求一律协商缓存
  app.use(
    express.static(WEB_DIR, {
      index: false,
      etag: true,
      lastModified: true,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    })
  );
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    serveIndex(req, res);
  });

  // 错误兜底：接口一律回 JSON。没有这一层时，抛错会返回 HTML 错误页，
  // 前端 JSON 解析失败，toast 只剩一句 "Unexpected token <"，真正原因全丢了。
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err && Number(err.status) >= 400 ? Number(err.status) : 500;
    console.error('[api]', req.method, req.originalUrl, err && (err.stack || err.message || err));
    const msg = (err && err.message) || '服务器错误';
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
    res.status(status).type('text/plain; charset=utf-8').send(msg);
  });

  return app;
}

function applyTags(db, charId, tags) {
  db.prepare('DELETE FROM character_tags WHERE character_id = ?').run(charId);
  for (const raw of tags) {
    const name = String(raw).trim().slice(0, 40);
    if (!name) continue;
    db.prepare('INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(name);
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    db.prepare('INSERT OR IGNORE INTO character_tags(character_id, tag_id) VALUES(?,?)').run(charId, tag.id);
  }
}
