import Database from 'better-sqlite3';
import { DB_FILE, DATA_DIR, ensureDirs } from './config.js';

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
