import Database from 'better-sqlite3';
import { DB_FILE, DATA_DIR, ensureDirs, slugify } from './config.js';

/**
 * 层级：资料库 → 角色库 → 角色 → 图包 → 媒体
 * 媒体文件本体存在 library/<角色目录>/ 下，这里只存索引。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS libraries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shelf_id       INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  account        TEXT,
  intro          TEXT NOT NULL DEFAULT '',
  dir_slug       TEXT NOT NULL,
  platforms      TEXT NOT NULL DEFAULT '[]',
  cover_media_id INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id   INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  month          TEXT,
  category       TEXT,
  cover_media_id INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  pack_id     INTEGER REFERENCES packs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  ext         TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  thumb_state INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS character_tags (
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (character_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_packs_char ON packs(character_id, month DESC);
-- 小库维度：同角色的「同月 + 同小库」只能有一个图包；人物库 category 为空，不受唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS uniq_packs_scope
  ON packs(character_id, month, category)
  WHERE month IS NOT NULL AND category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_pack ON media(pack_id, sort_order, file_name);
CREATE INDEX IF NOT EXISTS idx_media_char ON media(character_id, kind);
CREATE INDEX IF NOT EXISTS idx_chars_shelf ON characters(shelf_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_media_sha ON media(sha256);
`;

let db = null;

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  ensureDefaults(db);
  return db;
}

/**
 * 轻量迁移：给老库补列。
 * 注意 CREATE TABLE IF NOT EXISTS 不会改已有表，新增列必须在这里 ALTER。
 */
function migrate(d) {
  const addColumnIfMissing = (table, column, ddl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumnIfMissing('characters', 'platforms', `platforms TEXT NOT NULL DEFAULT '[]'`);
  // 小库：官图 / cosplay / 同人（只对虚拟角色库有意义，人物库留空）
  addColumnIfMissing('packs', 'category', `category TEXT`);
  // 图包 / 单个媒体自己的标签（JSON 数组），媒体最终标签还要并上角色标签与库标签
  addColumnIfMissing('packs', 'tags', `tags TEXT NOT NULL DEFAULT '[]'`);
  addColumnIfMissing('media', 'tags', `tags TEXT NOT NULL DEFAULT '[]'`);
  // 单个媒体的内容介绍（详情页可编辑，空着就用自动文案）
  addColumnIfMissing('media', 'intro', `intro TEXT NOT NULL DEFAULT ''`);
  // 真动图标记：按帧数（pages>1）判定，不是按扩展名
  addColumnIfMissing('media', 'anim', `anim INTEGER NOT NULL DEFAULT 0`);
  // 库类型：people 真人 / work 虚拟角色 / emoji 表情包（没有条目层级）
  addColumnIfMissing('shelves', 'kind', `kind TEXT NOT NULL DEFAULT 'people'`);
  // 表情库这类「扁平库」用一个隐藏条目承载图包和媒体，不当作真实条目展示
  addColumnIfMissing('characters', 'is_container', `is_container INTEGER NOT NULL DEFAULT 0`);
  // 资源库用：游戏 / 动画 / 电影 / 剧集（其他库留空）
  addColumnIfMissing('characters', 'category', `category TEXT`);
  ensureSelfTags(d);
}

/**
 * 每个条目自动带上自己的名字标签（纸悦 → 「纸悦」）。
 * 媒体标签本来就按「自有标签 + 条目名 + 库类型」算出来，这里只是把这层关系
 * 固化到 character_tags，让条目自己的标签行里也能看到它。
 */
/**
 * 清掉没人用的标签。
 * 条目被删之后它的名字标签会留在标签池里，越积越多，
 * 打标签时的「相似校验」会被这些幽灵标签误伤。
 * 判断依据：character_tags 里没有引用、也不是「人物 / 角色」，
 * 并且 packs / media 的 JSON 标签里都找不到。
 */
export function pruneOrphanTags(d = getDb()) {
  const rows = d
    .prepare(
      `SELECT t.id, t.name FROM tags t
        WHERE NOT EXISTS (SELECT 1 FROM character_tags ct WHERE ct.tag_id = t.id)
          AND t.name NOT IN ('人物', '角色')`
    )
    .all();
  if (!rows.length) return 0;
  const inPacks = d.prepare('SELECT 1 FROM packs WHERE tags LIKE ? LIMIT 1');
  const inMedia = d.prepare('SELECT 1 FROM media WHERE tags LIKE ? LIMIT 1');
  const del = d.prepare('DELETE FROM tags WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const pat = `%"${r.name}"%`;
    if (inPacks.get(pat) || inMedia.get(pat)) continue;
    del.run(r.id);
    n += 1;
  }
  return n;
}

export function ensureSelfTags(d = getDb()) {
  // 容器条目不是用户建的条目，给它打名字标签会污染整个标签池
  const chars = d.prepare('SELECT id, name FROM characters WHERE is_container = 0').all();
  if (!chars.length) return 0;
  const insTag = d.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)');
  const getTag = d.prepare('SELECT id FROM tags WHERE name = ?');
  const link = d.prepare('INSERT OR IGNORE INTO character_tags(character_id, tag_id) VALUES(?,?)');
  let n = 0;
  for (const c of chars) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    insTag.run(name);
    const t = getTag.get(name);
    if (!t) continue;
    n += link.run(c.id, t.id).changes;
  }
  return n;
}

/**
 * 扁平库（表情库）的容器条目：一个库一条，不出现在条目列表里。
 * 图包挂在它下面，媒体再挂在图包下面，这样目录层级简化为
 * <库名>/<图包>/<图片|视频>，不用为它单写一套表。
 */
export function ensureShelfContainer(shelfId) {
  const d = getDb();
  const shelf = d.prepare('SELECT * FROM shelves WHERE id = ?').get(shelfId);
  if (!shelf) return null;
  const found = d
    .prepare('SELECT * FROM characters WHERE shelf_id = ? AND is_container = 1 ORDER BY id LIMIT 1')
    .get(shelfId);
  if (found) return found;

  // 库目录名直接用库名；万一撞了已有目录就加序号
  const base = slugify(shelf.name) || '表情库';
  let dirSlug = base;
  let n = 2;
  while (d.prepare('SELECT 1 FROM characters WHERE dir_slug = ?').get(dirSlug)) {
    dirSlug = `${base}-${n}`;
    n += 1;
  }
  const ts = nowIso();
  const id = Number(
    d
      .prepare(
        `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, sort_order, created_at, updated_at, is_container)
         VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?,1)`
      )
      .run(shelfId, shelf.name, null, '', dirSlug, shelfId, ts, ts).lastInsertRowid
  );
  return d.prepare('SELECT * FROM characters WHERE id = ?').get(id);
}

export function nowIso() {
  return new Date().toISOString();
}

/** 首次启动建好「资料库 + 默认角色库」，用户打开就有地方放东西 */
function ensureDefaults(d) {
  const ts = nowIso();
  let lib = d.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get();
  if (!lib) {
    const info = d
      .prepare('INSERT INTO libraries(key, name, root_path, created_at) VALUES(?,?,?,?)')
      .run('main', '我的资料库', DATA_DIR, ts);
    lib = { id: Number(info.lastInsertRowid) };
  }
  const shelf = d.prepare('SELECT id FROM shelves WHERE library_id = ? ORDER BY sort_order, id LIMIT 1').get(lib.id);
  if (!shelf) {
    d.prepare('INSERT INTO shelves(library_id, name, note, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(
      lib.id,
      '角色库',
      '',
      0,
      ts,
      ts
    );
  }
}

export function mainLibrary() {
  return getDb().prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get();
}

export function defaultShelfId() {
  const lib = mainLibrary();
  const s = getDb().prepare('SELECT id FROM shelves WHERE library_id = ? ORDER BY sort_order, id LIMIT 1').get(lib.id);
  return s ? s.id : null;
}

/** 角色统计：媒体数、图包数、占用、封面 */
export function refreshCharacter(characterId) {
  const d = getDb();
  const stat = d
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b,
              COALESCE(SUM(CASE WHEN kind='image' THEN 1 ELSE 0 END),0) imgs,
              COALESCE(SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END),0) vids
       FROM media WHERE character_id = ?`
    )
    .get(characterId);
  const packs = d.prepare('SELECT COUNT(*) n FROM packs WHERE character_id = ?').get(characterId).n;
  const row = d.prepare('SELECT cover_media_id FROM characters WHERE id = ?').get(characterId);
  let cover = row ? row.cover_media_id : null;
  if (cover && !d.prepare('SELECT 1 FROM media WHERE id = ?').get(cover)) cover = null;
  if (!cover) {
    const first = d
      .prepare(
        `SELECT id FROM media WHERE character_id = ? AND kind IN ('image','video')
         ORDER BY CASE kind WHEN 'image' THEN 0 ELSE 1 END, sort_order, id LIMIT 1`
      )
      .get(characterId);
    cover = first ? first.id : null;
  }
  d.prepare(
    `UPDATE characters SET cover_media_id = ?, updated_at = ? WHERE id = ?`
  ).run(cover, nowIso(), characterId);
  return { media: stat.n, bytes: stat.b, images: stat.imgs, videos: stat.vids, packs };
}

export function refreshPack(packId) {
  const d = getDb();
  const cover = d
    .prepare(
      `SELECT id FROM media WHERE pack_id = ? AND kind IN ('image','video')
       ORDER BY CASE kind WHEN 'image' THEN 0 ELSE 1 END, sort_order, id LIMIT 1`
    )
    .get(packId);
  d.prepare('UPDATE packs SET cover_media_id = ? WHERE id = ?').run(cover ? cover.id : null, packId);
}

export function refreshCharacterPacks(characterId) {
  const d = getDb();
  for (const p of d.prepare('SELECT id FROM packs WHERE character_id = ?').all(characterId)) {
    refreshPack(p.id);
  }
}
