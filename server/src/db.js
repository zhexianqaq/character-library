import Database from 'better-sqlite3';
import { DB_FILE, DATA_DIR, ensureDirs, slugify } from './config.js';
import { splitTitleTags } from './pack-tags.js';

/**
 * 层级：资料库 → 角色集 → 角色 → 图包 → 媒体
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
-- 小库维度：同角色的「同月 + 同小库」只能有一个图包；人物集 category 为空，不受唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS uniq_packs_scope
  ON packs(character_id, month, category)
  WHERE month IS NOT NULL AND category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_pack ON media(pack_id, sort_order, file_name);
CREATE INDEX IF NOT EXISTS idx_media_char ON media(character_id, kind);
CREATE INDEX IF NOT EXISTS idx_chars_shelf ON characters(shelf_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_media_sha ON media(sha256);

/* ── 磁盘操作日志（v3.46） ──────────────────────────────────────────
   前端的每次改动都记一条：改了什么、涉及哪些路径、落盘了没有。
   同步按钮只处理这里没落实的（pending / failed）和还没校验过的，
   不再全库扫描。payload 里存路径快照 —— 记录被删了也要知道动哪些文件。 */
CREATE TABLE IF NOT EXISTS fs_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'ui',      -- ui | shell | cli | sync
  entity      TEXT NOT NULL,                   -- pack | media | character
  entity_id   INTEGER,
  action      TEXT NOT NULL,                   -- create|rename|move|delete|dissolve|add|alias
  payload     TEXT NOT NULL DEFAULT '{}',      -- {from,to,paths[],mediaIds[],packId,title}
  status      TEXT NOT NULL DEFAULT 'done',    -- pending | done | failed | canceled
  reason      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  applied_at  TEXT,
  verified_at TEXT,                            -- 同步时核对通过的标记
  run_id      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fs_ops_open ON fs_ops(status, id);
CREATE INDEX IF NOT EXISTS idx_fs_ops_unverified ON fs_ops(verified_at) WHERE verified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fs_ops_entity ON fs_ops(entity, entity_id, id);

CREATE TABLE IF NOT EXISTS fs_sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  mode         TEXT NOT NULL DEFAULT 'incremental',  -- incremental | full
  applied      INTEGER NOT NULL DEFAULT 0,
  verified     INTEGER NOT NULL DEFAULT 0,
  repaired     INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  files_moved  INTEGER NOT NULL DEFAULT 0,
  dirs_removed INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);
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
  // 别名：简称 / 日文名 / 英文名，JSON 数组；人物、角色、资源（游戏/动画/电影/剧集）共用
  addColumnIfMissing('characters', 'aliases', `aliases TEXT NOT NULL DEFAULT '[]'`);
  // 小库：官图 / cos / 同人（只对虚拟角色集有意义，人物集留空）
  addColumnIfMissing('packs', 'category', `category TEXT`);
  // 图包 / 单个媒体自己的标签（JSON 数组），媒体最终标签还要并上角色标签与库标签
  addColumnIfMissing('packs', 'tags', `tags TEXT NOT NULL DEFAULT '[]'`);
  addColumnIfMissing('media', 'tags', `tags TEXT NOT NULL DEFAULT '[]'`);
  // 单个媒体的内容介绍（详情页可编辑，空着就用自动文案）
  addColumnIfMissing('media', 'intro', `intro TEXT NOT NULL DEFAULT ''`);
  // 真动图标记：按帧数（pages>1）判定，不是按扩展名
  addColumnIfMissing('media', 'anim', `anim INTEGER NOT NULL DEFAULT 0`);
  /* 视频自定义封面：poster_rel 是相对 DATA_DIR 的 webp（.covers/<桶>/<id>.webp），
     poster_ms 记录抽的是第几毫秒那一帧。
     两列都为空 = 用自动首帧；清了缓存盘也不影响，因为它不在缓存盘上。 */
  addColumnIfMissing('media', 'poster_rel', `poster_rel TEXT`);
  addColumnIfMissing('media', 'poster_ms', `poster_ms INTEGER`);
  /* 漫画页序：只在 packs.kind='comic' 里有意义，和图包排序（sort_order）完全分开 ——
     改图包的排序不该打乱漫画的阅读顺序。转成漫画时按文件名自然序写入 1..N。 */
  addColumnIfMissing('media', 'page_no', `page_no INTEGER`);
  // 库类型：people 真人 / work 虚拟角色 / emoji 表情包 / resource 作品录 / novel 小说库
  addColumnIfMissing('shelves', 'kind', `kind TEXT NOT NULL DEFAULT 'people'`);
  // 小说库细分：original 原创 / fanfic 同人（其他库留空）
  addColumnIfMissing('shelves', 'variant', `variant TEXT`);
  // 表情包这类「扁平库」用一个隐藏条目承载图包和媒体，不当作真实条目展示
  addColumnIfMissing('characters', 'is_container', `is_container INTEGER NOT NULL DEFAULT 0`);
  // 作品录用：游戏 / 动画 / 电影 / 剧集（其他库留空）
  addColumnIfMissing('characters', 'category', `category TEXT`);
  /* 小说库（kind='novel'）
     novel_group   归类文件夹：原创=小说类型（玄幻/都市…），同人=原作品名（原神/明日方舟…）
                   同时也是磁盘上的一层目录：<库>/<novel_group>/<书名>/
     novel_subtype 分类视图：原创=出版/网络，同人=短篇/长篇。**不落磁盘**，只做筛选 */
  addColumnIfMissing('characters', 'novel_group', `novel_group TEXT`);
  addColumnIfMissing('characters', 'novel_subtype', `novel_subtype TEXT`);
  addColumnIfMissing('characters', 'author', `author TEXT`);
  addColumnIfMissing('characters', 'word_count', `word_count INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing('characters', 'novel_status', `novel_status TEXT`);
  // 索引必须在补列之后建（老库一开始没有 novel_group 这一列）
  d.exec(`CREATE INDEX IF NOT EXISTS idx_chars_novel_group ON characters(shelf_id, novel_group)`);
  // 内容文件夹类型：pack 图包 / novel 书袋 / comic 漫画（后两种见 README）
  addColumnIfMissing('packs', 'kind', `kind TEXT NOT NULL DEFAULT 'pack'`);
  ensureNovelBags(d);
  ensureSelfTags(d);
  normalizePackTitleTags(d);
  normalizePackOwnerTags(d);
}

/**
 * 书袋：把每个小说库里不同的「类型 / 原作」实体化成一条 pack（kind='novel'）。
 *
 * 书与书袋的关系继续沿用 characters.novel_group（= 书袋名），所以这里只补记录、不动书；
 * 封面 / 标签 / 排序这些能力直接复用图包那套（packs 表）。
 * 书袋挂在库的容器条目下，和表情包、收件箱是同一个模式。
 */
function ensureNovelBags(d) {
  const shelves = d.prepare("SELECT id, name FROM shelves WHERE kind = 'novel'").all();
  for (const s of shelves) {
    const groups = d
      .prepare(
        `SELECT COALESCE(novel_group,'') g, COUNT(*) n FROM characters
          WHERE shelf_id = ? AND is_container = 0 GROUP BY COALESCE(novel_group,'')`
      )
      .all(s.id);
    if (!groups.length) continue;

    let container = d
      .prepare('SELECT * FROM characters WHERE shelf_id = ? AND is_container = 1 ORDER BY id LIMIT 1')
      .get(s.id);
    if (!container) {
      // 迁移期不调 ensureShelfContainer（它会走 getDb()），这里用同一个连接直接建
      const base = slugify(s.name) || '小说库';
      let dirSlug = base;
      let n = 2;
      while (d.prepare('SELECT 1 FROM characters WHERE dir_slug = ?').get(dirSlug)) {
        dirSlug = `${base}-${n}`;
        n += 1;
      }
      const ts = nowIso();
      const cid = Number(
        d
          .prepare(
            `INSERT INTO characters(shelf_id, name, account, intro, dir_slug, sort_order, created_at, updated_at, is_container)
             VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM characters WHERE shelf_id=?),?,?,1)`
          )
          .run(s.id, s.name, null, '', dirSlug, s.id, ts, ts).lastInsertRowid
      );
      container = { id: cid };
    }

    for (const { g } of groups) {
      const title = String(g || '').trim() || '未分类';
      const exists = d
        .prepare("SELECT 1 FROM packs WHERE character_id = ? AND kind = 'novel' AND title = ?")
        .get(container.id, title);
      if (exists) continue;
      d.prepare(
        `INSERT INTO packs(character_id, title, month, category, kind, tags, sort_order, created_at)
         VALUES(?,?,NULL,NULL,'novel',?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM packs WHERE character_id=?),?)`
      ).run(container.id, title, JSON.stringify([title]), container.id, nowIso());
    }
  }
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
          AND t.name NOT IN ('人物', '角色', '小说')`
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

/**
 * 存量图包的「同名标签」按新规则重拆一遍。
 *
 * v3.31.2 起建包会写一条和图包同名的标签，但 `卡芙卡-泳装` 当时是整串一条，
 * 角色页靠「标签 = 条目名」永远匹配不上。这里只处理「标签里正好有整串图包名」的包，
 * 拆成「卡芙卡」「泳装」两条；用户自己加的其他标签一个都不动。
 * 纯日期名（2026-10）和含数字段的名字不会被拆，见 splitTitleTags。
 */
function normalizePackTitleTags(d) {
  const rows = d.prepare('SELECT id, title, tags FROM packs').all();
  const upd = d.prepare('UPDATE packs SET tags = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const title = String(r.title || '').trim();
    if (!title) continue;
    const parts = splitTitleTags(title);
    if (parts.length < 2) continue;
    let tags;
    try {
      tags = JSON.parse(r.tags || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(tags) || !tags.includes(title)) continue;
    const next = [...new Set([...tags.filter((t) => t !== title), ...parts])].slice(0, 30);
    upd.run(JSON.stringify(next), r.id);
    n += 1;
  }
  return n;
}

/**
 * 图包标签补上「所属条目名」。
 *
 * 图包挂在某个条目下面，那个条目的名字本身就是一个有意义的标签：搜「水淼」
 * 应该能一次看到她的所有图包，点标签也能落到标签页。只在缺失时补一条，
 * 已有的其他标签一个都不动；容器条目（表情包 / 收件箱 / 书袋）跳过。
 */
function normalizePackOwnerTags(d) {
  const rows = d
    .prepare(
      `SELECT p.id, p.tags, c.name AS owner
         FROM packs p JOIN characters c ON c.id = p.character_id
        WHERE c.is_container = 0`
    )
    .all();
  const upd = d.prepare('UPDATE packs SET tags = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const owner = String(r.owner || '').trim();
    if (!owner) continue;
    let tags;
    try {
      tags = JSON.parse(r.tags || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(tags) || tags.includes(owner)) continue;
    upd.run(JSON.stringify([...tags, owner].slice(0, 30)), r.id);
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
 * 扁平库（表情包）的容器条目：一个库一条，不出现在条目列表里。
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
  const base = slugify(shelf.name) || '表情包';
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

/** 首次启动建好「资料库 + 默认角色集」，用户打开就有地方放东西 */
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
    // kind 必须显式给：schema 的默认值是 people，不写就变成「名字叫角色集、实际按人物集处理」
    // （单位词、小库分类都会跟着错）
    d.prepare(
      'INSERT INTO shelves(library_id, name, note, kind, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run(lib.id, '角色集', '', 'work', 0, ts, ts);
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

/**
 * 图包封面：**手动设过就保留**，只有没设 / 设的那张已经不在包里了才回落到第一张。
 * （以前无条件覆盖，右键「设为图包封面」会在下次上传时被悄悄改回去）
 */
export function refreshPack(packId) {
  const d = getDb();
  const row = d.prepare('SELECT cover_media_id FROM packs WHERE id = ?').get(packId);
  let cover = row ? row.cover_media_id : null;
  const valid =
    cover && d.prepare('SELECT 1 FROM media WHERE id = ? AND pack_id = ? AND kind IN (?,?)').get(cover, packId, 'image', 'video');
  if (!valid) {
    const first = d
      .prepare(
        `SELECT id FROM media WHERE pack_id = ? AND kind IN ('image','video')
         ORDER BY CASE kind WHEN 'image' THEN 0 ELSE 1 END, sort_order, id LIMIT 1`
      )
      .get(packId);
    cover = first ? first.id : null;
  }
  d.prepare('UPDATE packs SET cover_media_id = ? WHERE id = ?').run(cover, packId);
}

/**
 * 条目统计的合并刷新（上传队列专用）。
 *
 * 队列是「一个文件一个请求」，同一角色连传 50 张就会把 3 条聚合 + 封面查询
 * 跑 50 遍。这里做 leading + trailing：
 *   第一次立刻算 —— 上传一返回，前端重新拉列表看到的就是新数字；
 *   `wait` 毫秒内的后续请求合并成窗口结束时的一次。
 * 只用于「连续写同一个角色」的场景；其他接口要即时结果就继续用 refreshCharacter。
 */
const charRefreshTimers = new Map();

export function refreshCharacterSoon(characterId, wait = 400) {
  const id = Number(characterId) || 0;
  if (!id) return;
  const pending = charRefreshTimers.get(id);
  if (pending) clearTimeout(pending);
  else refreshCharacter(id);
  charRefreshTimers.set(
    id,
    setTimeout(() => {
      charRefreshTimers.delete(id);
      refreshCharacter(id);
    }, wait)
  );
}

export function refreshCharacterPacks(characterId) {
  const d = getDb();
  for (const p of d.prepare('SELECT id FROM packs WHERE character_id = ?').all(characterId)) {
    refreshPack(p.id);
  }
}
