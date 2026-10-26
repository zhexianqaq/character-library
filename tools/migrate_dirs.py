"""把已有媒体从 <角色>/file 重组为 <角色库>/<角色>/<图包>/<图片|视频>/file。

同盘 shutil.move 走 rename，瞬间完成；先备份索引库。
用法：python tools/migrate_dirs.py
"""
import os
import re
import shutil
import sqlite3
import sys

DATA = r'E:\CharacterLibrary'
DB = os.path.join(DATA, '.catalog', 'library.db')


def slugify(name):
    s = re.sub(r'[\\/:*?"<>|]', '_', str(name or ''))
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:60] or 'unnamed'


def unique(base_abs, name):
    base = slugify(name)
    cand = base
    i = 2
    while os.path.exists(os.path.join(base_abs, cand)):
        cand = f'{base}-{i}'
        i += 1
    return cand


if not os.path.exists(DB):
    print(f'索引库不存在：{DB}')
    sys.exit(1)

bak = DB + '.bak'
if not os.path.exists(bak):
    shutil.copy2(DB, bak)
    print(f'已备份索引库 -> {bak}')

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

shelves = {r['id']: r for r in db.execute('SELECT * FROM shelves')}
chars = db.execute('SELECT * FROM characters ORDER BY id').fetchall()

moved = 0
missing = 0
new_shelf_dirs = set()
# 同一个角色库只算一次目录名，否则每个角色都会撞出「角色库-2」「角色库-3」
shelf_slug_cache = {}

for c in chars:
    shelf = shelves.get(c['shelf_id'])
    if not shelf:
        print(f'跳过角色 {c["name"]}：找不到所属角色库')
        continue

    if c['shelf_id'] not in shelf_slug_cache:
        shelf_slug_cache[c['shelf_id']] = unique(DATA, shelf['name'])
    shelf_slug = shelf_slug_cache[c['shelf_id']]
    shelf_abs = os.path.join(DATA, shelf_slug)
    os.makedirs(shelf_abs, exist_ok=True)
    new_shelf_dirs.add(shelf_slug)

    char_slug = unique(shelf_abs, c['name'])
    char_abs = os.path.join(shelf_abs, char_slug)
    os.makedirs(char_abs, exist_ok=True)
    base_rel = f'{shelf_slug}/{char_slug}'

    pack_dir = {}
    for p in db.execute(
        'SELECT * FROM packs WHERE character_id = ? ORDER BY month DESC, id DESC', (c['id'],)
    ).fetchall():
        slug = unique(char_abs, p['title'])
        d_abs = os.path.join(char_abs, slug)
        os.makedirs(d_abs, exist_ok=True)
        pack_dir[p['id']] = (f'{base_rel}/{slug}', d_abs)

    orphan_dir = os.path.join(char_abs, '未分类')
    for m in db.execute('SELECT * FROM media WHERE character_id = ?', (c['id'],)).fetchall():
        src = os.path.join(DATA, *m['rel_path'].split('/'))
        fname = os.path.basename(src)

        if m['pack_id'] in pack_dir:
            pack_rel, pack_abs = pack_dir[m['pack_id']]
        else:
            pack_rel = f'{base_rel}/未分类'
            pack_abs = orphan_dir
            os.makedirs(pack_abs, exist_ok=True)

        type_dir = '图片' if m['kind'] == 'image' else '视频'
        tgt_abs_dir = os.path.join(pack_abs, type_dir)
        os.makedirs(tgt_abs_dir, exist_ok=True)
        tgt = os.path.join(tgt_abs_dir, fname)
        new_rel = f'{pack_rel}/{type_dir}/{fname}'

        if os.path.exists(src):
            if os.path.abspath(src) != os.path.abspath(tgt):
                shutil.move(src, tgt)
                moved += 1
        else:
            missing += 1
        db.execute('UPDATE media SET rel_path = ? WHERE id = ?', (new_rel, m['id']))

    db.execute('UPDATE characters SET dir_slug = ? WHERE id = ?', (base_rel, c['id']))
    print(f'  {c["name"]}: {base_rel}  图包 {len(pack_dir)} 个')

db.commit()

# 清理旧的平铺角色目录（只删空目录，非空的不动，report 出来）
removed = []
for entry in os.listdir(DATA):
    path = os.path.join(DATA, entry)
    if not os.path.isdir(path):
        continue
    if entry.startswith('.') or entry in new_shelf_dirs:
        continue
    try:
        if not os.listdir(path):
            os.rmdir(path)
            removed.append(entry)
    except OSError:
        pass

print(f'\n移动 {moved} 个文件，缺失 {missing} 个')
if removed:
    print(f'清理空目录 {len(removed)} 个: {", ".join(removed)}')
print('完成。')
