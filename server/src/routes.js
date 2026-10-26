import express from 'express';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import {
  getDb,
  nowIso,
  mainLibrary,
  defaultShelfId,
  refreshCharacter,
  refreshPack,
  refreshCharacterPacks,
  ensureSelfTags,
} from './db.js';
import { getDerivative, warmAll, warmState } from './thumbs.js';
import { WEB_DIR, INBOX_DIR, DATA_DIR, slugify } from './config.js';
import {
  absPathOf,
  adoptFile,
  hashFileOf,
  relocateFile,
  removeLibraryFile,
  removeDir,
  kindOfExt,
  uniqueDirName,
} from './store.js';
import { monthOfFileName, monthTitle } from './importer.js';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};


const upload = multer({
  dest: INBOX_DIR,
  limits: { fileSize: 4 * 1024 ** 3, files: 400 },
});

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

/** 媒体继承的标签：角色自己的标签 + 库类型（人物/角色）+ 角色名本身 */
function mediaTagSet(db, charId) {
  const c = db
    .prepare(`SELECT c.name, sh.kind FROM characters c LEFT JOIN shelves sh ON sh.id = c.shelf_id WHERE c.id = ?`)
    .get(charId);
  if (!c) return [];
  const set = new Set(tagsOf(db, charId));
  set.add(c.name);
  set.add(c.kind === 'work' ? '角色' : '人物');
  return [...set];
}

function mapChar(row, tags) {
  return {
    id: row.id,
    shelfId: row.shelf_id,
    name: row.name,
    account: row.account,
    intro: row.intro,
    dirSlug: row.dir_slug,
    coverMediaId: row.cover_media_id,
    mediaCount: row.media_count ?? 0,
    packCount: row.pack_count ?? 0,
    bytes: row.total_bytes ?? 0,
    tags: tags || [],
    platforms: safeJson(row.platforms),
    shelf: {
      id: row.shelf_id,
      name: row.shelf_name || '',
      kind: row.shelf_kind || 'people',
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

/** 库的类型：people=真人（有社交账号）/ work=虚拟角色（标注出处） */
function normalizeShelfKind(v) {
  return String(v || '').toLowerCase() === 'work' ? 'work' : 'people';
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
  SELECT c.*, sh.name AS shelf_name, sh.kind AS shelf_kind,
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
    fileName: r.file_name,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    bytes: r.bytes,
    sortOrder: r.sort_order,
    tags: own,
    // 自己手动打的标签；tags 会被调用方替换成「含继承」的完整集合
    ownTags: own,
  };
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
        `INSERT INTO packs(character_id, title, month, category, sort_order, created_at)
         VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
      )
      .run(charId, title, month, category, charId, nowIso()).lastInsertRowid
  );
  return { id, title };
}

/**
 * 算出文件该落在哪个目录：<角色库>/<角色>/<图包>/<图片|视频>
 * 图包目录沿用库里已有文件的位置；新图包才新建目录，避免重复生成 -2 -3
 */
async function resolvePackDir(db, charRelDir, pack, kind, category = null) {
  const typeDir = kind === 'image' ? '图片' : '视频';
  const existing = db.prepare('SELECT rel_path FROM media WHERE pack_id = ? LIMIT 1').get(pack.id);
  if (existing) {
    const parts = existing.rel_path.split('/');
    return [...parts.slice(0, -2), typeDir].join('/');
  }
  // 虚拟角色库：库/角色/小库/图包/图片|视频
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
 * 新建角色的目录：<角色库>/<角色>
 * 角色库那一段必须复用已有角色用过的名字，不能每次 slugify 一遍，
 * 否则同一个库会裂成「角色库」「角色库-2」。
 */
async function uniqueCharRelDir(db, shelfId, name) {
  const shelf = db.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
  const sample = db
    .prepare(`SELECT dir_slug FROM characters WHERE shelf_id = ? AND dir_slug LIKE '%/%' LIMIT 1`)
    .get(shelfId);
  const shelfSlug = sample ? sample.dir_slug.split('/')[0] : slugify(shelf ? shelf.name : '角色库');
  const charSlug = await uniqueDirName(shelfSlug, name);
  return `${shelfSlug}/${charSlug}`;
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
           (SELECT COUNT(*) FROM characters c WHERE c.shelf_id = s.id) AS character_count,
           (SELECT COUNT(*) FROM media m JOIN characters c ON c.id = m.character_id WHERE c.shelf_id = s.id) AS media_count,
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
           (SELECT COUNT(*) FROM characters) characters,
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
        characterCount: s.character_count,
        mediaCount: s.media_count,
        bytes: s.bytes,
        coverMediaId: s.cover_media_id,
      })),
      totals,
    });
  });

  // ---------- 角色库 ----------
  app.post('/api/shelves', (req, res) => {
    const db = getDb();
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: '角色库名称不能为空' });
    const lib = mainLibrary();
    const id = Number(
      db
        .prepare(
          `INSERT INTO shelves(library_id, name, note, kind, sort_order, created_at, updated_at)
           VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM shelves WHERE library_id=?),?,?)`
        )
        .run(
          lib.id,
          name.slice(0, 60),
          String(req.body.note || '').slice(0, 500),
          normalizeShelfKind(req.body.kind),
          lib.id,
          nowIso(),
          nowIso()
        )
        .lastInsertRowid
    );
    res.json({ id, name, kind: normalizeShelfKind(req.body.kind) });
  });

  app.patch('/api/shelves/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const { name, note, kind } = req.body || {};
    const row = db.prepare('SELECT * FROM shelves WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '库不存在' });
    db.prepare('UPDATE shelves SET name = ?, note = ?, kind = ?, updated_at = ? WHERE id = ?').run(
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : row.name,
      typeof note === 'string' ? note.slice(0, 500) : row.note,
      kind === undefined ? row.kind : normalizeShelfKind(kind),
      nowIso(),
      id
    );
    res.json({ ok: true });
  });

  app.delete('/api/shelves/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const n = db.prepare('SELECT COUNT(*) n FROM characters WHERE shelf_id = ?').get(id).n;
    if (n > 0) return res.status(400).json({ error: `该角色库下还有 ${n} 个角色，请先移走或删除` });
    db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
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
        target = path.dirname(absPathOf(first.rel_path));
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
      const isDir = fs.statSync(abs).isDirectory();
      // explorer 成功也可能返回 1，忽略退出码
      execFile('explorer.exe', [isDir ? abs : `/select,${abs}`], () => {});
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

  // ---------- 角色 ----------
  app.get('/api/shelves/:id/characters', (req, res) => {
    const db = getDb();
    const shelfId = Number(req.params.id);
    const q = String(req.query.q || '').trim();
    const sort = String(req.query.sort || 'recent');
    const where = ['c.shelf_id = @shelfId'];
    const params = { shelfId };
    if (q) {
      where.push('(c.name LIKE @q OR c.account LIKE @q)');
      params.q = `%${q}%`;
    }
    const order =
      sort === 'name' ? 'ORDER BY c.name COLLATE NOCASE'
      : sort === 'media' ? 'ORDER BY media_count DESC'
      : 'ORDER BY c.updated_at DESC, c.id DESC';
    const rows = db
      .prepare(`${CHAR_SELECT} WHERE ${where.join(' AND ')} ${order}`)
      .all(params);
    res.json({ items: rows.map((r) => mapChar(r, tagsOf(db, r.id))), total: rows.length });
  });

  app.post('/api/characters', async (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: '角色名不能为空' });
    const shelfId = Number(b.shelfId) || defaultShelfId();
    const dirSlug = await uniqueCharRelDir(db, shelfId, name);
    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, sort_order, created_at, updated_at)
         VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?)`
      )
      .run(shelfId, name.slice(0, 100), String(b.account || '').slice(0, 100), String(b.intro || '').slice(0, 20000), dirSlug, shelfId, ts, ts);
    const id = Number(info.lastInsertRowid);
    if (Array.isArray(b.tags) && b.tags.length) applyTags(db, id, b.tags);
    ensureSelfTags(db); // 新条目立刻带上自己的名字标签
    const row = db.prepare(`${CHAR_SELECT} WHERE c.id = ?`).get(id);
    res.json(mapChar(row, tagsOf(db, id)));
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
      stats: { image: byKind.image || 0, video: byKind.video || 0, total: byKind.image + byKind.video || 0 },
    });
  });

  app.patch('/api/characters/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '角色不存在' });
    const b = req.body || {};
    const tx = db.transaction(() => {
      if (typeof b.name === 'string' && b.name.trim()) {
        db.prepare('UPDATE characters SET name = ?, updated_at = ? WHERE id = ?').run(b.name.trim().slice(0, 100), nowIso(), id);
      }
      if (typeof b.account === 'string') {
        db.prepare('UPDATE characters SET account = ?, updated_at = ? WHERE id = ?').run(b.account.slice(0, 100), nowIso(), id);
      }
      if (typeof b.intro === 'string') {
        db.prepare('UPDATE characters SET intro = ?, updated_at = ? WHERE id = ?').run(b.intro.slice(0, 20000), nowIso(), id);
      }
      if (b.coverMediaId !== undefined) {
        db.prepare('UPDATE characters SET cover_media_id = ?, updated_at = ? WHERE id = ?').run(
          b.coverMediaId === null ? null : Number(b.coverMediaId), nowIso(), id
        );
      }
      if (Array.isArray(b.tags)) applyTags(db, id, b.tags);
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
    });
    tx();
    // 名字标签始终跟着条目走：改名补新名，手删了也会补回来
    ensureSelfTags(db);
    const fresh = db.prepare(`${CHAR_SELECT} WHERE c.id = ?`).get(id);
    res.json(mapChar(fresh, tagsOf(db, id)));
  });

  app.delete('/api/characters/:id', async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '角色不存在' });
    const paths = db.prepare('SELECT rel_path FROM media WHERE character_id = ?').all(row.id);
    db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);
    for (const p of paths) await removeLibraryFile(p.rel_path);
    await removeDir(row.dir_slug);
    res.json({ ok: true });
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
           (SELECT COUNT(*) FROM media m WHERE m.pack_id = p.id AND m.kind='video') AS video_count
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
        mediaCount: r.media_count,
        imageCount: r.image_count,
        videoCount: r.video_count,
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
          `INSERT INTO packs(character_id, title, month, category, sort_order, created_at)
           VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
        )
        .run(charId, title.slice(0, 100), month, category, charId, nowIso()).lastInsertRowid
    );
    res.json({ id, title, month, category, autoMonth: !hasTitle && !hasMonth });
  });

  app.get('/api/packs/:id', (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT p.*, c.name AS char_name, c.id AS char_id, c.account AS char_account
         FROM packs p JOIN characters c ON c.id = p.character_id WHERE p.id = ?`
      )
      .get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '图包不存在' });
    res.json({
      id: row.id,
      title: row.title,
      month: row.month,
      category: row.category,
      tags: safeJson(row.tags),
      createdAt: row.created_at,
      coverMediaId: row.cover_media_id,
      character: { id: row.char_id, name: row.char_name, account: row.char_account },
      counts: db
        .prepare(`SELECT kind, COUNT(*) n FROM media WHERE pack_id = ? GROUP BY kind`)
        .all(row.id)
        .reduce((acc, k) => ({ ...acc, [k.kind]: k.n }), {}),
    });
  });

  app.patch('/api/packs/:id', (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '图包不存在' });
    const b = req.body || {};
    try {
      if (typeof b.title === 'string' && b.title.trim()) {
        db.prepare('UPDATE packs SET title = ? WHERE id = ?').run(b.title.trim().slice(0, 100), id);
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
        db.prepare('UPDATE packs SET tags = ? WHERE id = ?').run(JSON.stringify(cleanTags(b.tags)), id);
      }
    } catch (err) {
      return res.status(400).json({ error: String(err.message || '保存失败') });
    }
    const fresh = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    res.json({ ok: true, id, title: fresh.title, month: fresh.month, createdAt: fresh.created_at });
  });

  // 默认「解散」：只删图包，里面的媒体变成未归包；
  // ?withMedia=1 是「删除」：连图包里的媒体和磁盘文件一起删掉
  app.delete('/api/packs/:id', async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM packs WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '图包不存在' });
    const withMedia = String(req.query.withMedia || '') === '1';
    let removed = 0;
    if (withMedia) {
      const items = db.prepare('SELECT id, rel_path FROM media WHERE pack_id = ?').all(id);
      db.prepare('DELETE FROM media WHERE pack_id = ?').run(id);
      for (const m of items) await removeLibraryFile(m.rel_path);
      removed = items.length;
    } else {
      db.prepare('UPDATE media SET pack_id = NULL WHERE pack_id = ?').run(id);
    }
    db.prepare('DELETE FROM packs WHERE id = ?').run(id);
    refreshCharacter(row.character_id);
    res.json({ ok: true, removed });
  });

  app.get('/api/packs/:id/media', (req, res) => {
    const db = getDb();
    const packId = Number(req.params.id);
    const pack = db.prepare('SELECT character_id FROM packs WHERE id = ?').get(packId);
    const rows = db
      .prepare('SELECT * FROM media WHERE pack_id = ? ORDER BY sort_order, file_name')
      .all(packId);
    const base = pack ? mediaTagSet(db, pack.character_id) : [];
    res.json({
      items: rows.map((r) => ({ ...mapMedia(r), tags: mergeTags(r.tags ? safeJson(r.tags) : [], base) })),
      total: rows.length,
    });
  });

  // ---------- 媒体 ----------

  /**
   * 素材挑选器（「添加到图包」用）。
   * scope: all 全部素材 / character 本角色 / loose 未归包 / filed 已归包
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

    const where = [];
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
      // 条目名也算可搜内容：媒体会继承条目名标签，搜「纸悦」就该出她全部素材
      where.push('(m.file_name LIKE @q OR m.tags LIKE @q OR c.name LIKE @q)');
      params.q = `%${q}%`;
    }
    const clause = where.length ? where.join(' AND ') : '1=1';

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n FROM media m LEFT JOIN characters c ON c.id = m.character_id WHERE ${clause}`
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
    const skipped = [];
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
        continue;
      }

      const dup = dupCheck.get(pack.character_id, row.sha256);
      if (dup) {
        skipped.push({ id, reason: '目标角色已有相同文件' });
        continue;
      }

      let relPath;
      try {
        const relDir = await resolvePackDir(db, target.dir_slug, pack, row.kind, pack.category);
        relPath = await relocateFile(row.rel_path, relDir);
      } catch (err) {
        skipped.push({ id, reason: `文件搬迁失败：${err.message || err}` });
        continue;
      }
      order += 1;
      crossMove.run(pack.character_id, packId, relPath, order, id);
      touched.add(row.character_id);
      moved.push(id);
    }

    refreshPack(packId);
    for (const cid of touched) refreshCharacter(cid);
    res.json({ ok: true, moved: moved.length, skipped, ids: moved });
  });

  app.get('/api/characters/:id/media', (req, res) => {
    const db = getDb();
    const charId = Number(req.params.id);
    const kind = String(req.query.kind || '').trim();
    const where = ['character_id = @charId'];
    const params = { charId };
    if (kind === 'image' || kind === 'video') {
      where.push('kind = @kind');
      params.kind = kind;
    }
    const rows = db
      .prepare(`SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY sort_order DESC, id DESC`)
      .all(params);
    const base = mediaTagSet(db, charId);
    res.json({
      items: rows.map((r) => ({ ...mapMedia(r), tags: mergeTags(r.tags ? safeJson(r.tags) : [], base) })),
      total: rows.length,
    });
  });

  app.post('/api/characters/:id/media', upload.array('files', 400), async (req, res) => {
    const db = getDb();
    const charId = Number(req.params.id);
    const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '没有收到文件' });

    const forcedPackId = req.body && req.body.packId ? Number(req.body.packId) : null;
    const category = String((req.body && req.body.category) || '').trim().slice(0, 20) || null;
    const added = [];
    const skipped = [];

    for (const f of files) {
      const originalName = decodeName(f.originalname);
      const drop = () => fsp.unlink(f.path).catch(() => {});
      const kind = kindOfExt(path.extname(originalName).toLowerCase());
      if (!kind) {
        await drop();
        skipped.push({ name: originalName, reason: '不支持的文件类型' });
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
      if (db.prepare('SELECT id FROM media WHERE character_id = ? AND sha256 = ?').get(charId, sha)) {
        await drop();
        skipped.push({ name: originalName, reason: '重复文件' });
        continue;
      }

      // 先定图包，才知道文件该进哪个目录
      const month = monthOfFileName(originalName);
      const pack = forcedPackId
        ? db.prepare('SELECT id, title, category FROM packs WHERE id = ?').get(forcedPackId)
        : ensurePackFor(db, charId, month, category);
      if (!pack) {
        await drop();
        skipped.push({ name: originalName, reason: '图包不存在' });
        continue;
      }

      const relDir = await resolvePackDir(db, char.dir_slug, pack, kind, pack.category || category);

      let saved;
      try {
        saved = await adoptFile(f.path, relDir, originalName, sha);
      } catch (err) {
        await drop();
        skipped.push({ name: originalName, reason: `写入失败：${err.code || err.message}` });
        continue;
      }
      if (!saved) {
        skipped.push({ name: originalName, reason: '不支持的文件类型' });
        continue;
      }

      const info = db
        .prepare(
          `INSERT INTO media(character_id, pack_id, kind, rel_path, file_name, ext, bytes, sha256, width, height, sort_order, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,
             (SELECT COALESCE(MAX(sort_order),-1)+1 FROM media WHERE pack_id IS ?),?)`
        )
        .run(charId, pack.id, kind, saved.relPath, originalName, saved.ext, saved.bytes, saved.sha256, saved.width, saved.height, pack.id, nowIso());
      const newId = Number(info.lastInsertRowid);
      added.push(newId);
      getDerivative(newId, 'thumb').catch(() => {});
    }

    refreshCharacterPacks(charId);
    refreshCharacter(charId);
    res.json({ added: added.length, skipped, ids: added });
  });

  /** 单个媒体详情（详情页用）：带上所属条目 / 图包 / 库，标签是含继承的完整集合 */
  app.get('/api/media/:id', (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT m.*, c.name AS char_name, sh.name AS shelf_name, sh.kind AS shelf_kind,
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
    res.json({
      ...mapMedia(row),
      tags: mergeTags(own, base),
      ownTags: own,
      intro: row.intro || '',
      createdAt: row.created_at,
      thumb: `/t/${row.id}`,
      preview: `/pv/${row.id}`,
      original: `/m/${row.id}`,
      pack: row.pack_id
        ? { id: row.pack_id, title: row.pack_title, month: row.pack_month, category: row.pack_category }
        : null,
      character: { id: row.character_id, name: row.char_name },
      shelf: { name: row.shelf_name || '', kind: row.shelf_kind || 'people' },
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
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    await removeLibraryFile(row.rel_path);
    refreshPack(row.pack_id);
    refreshCharacter(row.character_id);
    res.json({ ok: true });
  });

  // ---------- 派生图与原文件 ----------
  // 注意：缓存放在 .catalog 下，send 库默认拒绝 dotfile，必须显式 dotfiles:'allow'
  app.get('/t/:id', async (req, res) => {
    try {
      const p = await getDerivative(Number(req.params.id), 'thumb');
      if (!p) return res.status(404).end();
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
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
