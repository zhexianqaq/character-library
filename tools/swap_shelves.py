"""
一次性迁移：
1. 交换两个库的名字与磁盘目录
   现在的「角色库」(有数据, 真人) → 「人物库」
   现在的「人物库」(空)          → 「角色库」(放虚拟角色)
2. shelves 增加 kind 列：people(真人, 有社交账号) / work(虚拟角色, 标注出处)
3. 同步 characters.dir_slug 与 media.rel_path 的前缀

只改目录名和路径字符串，不移动任何文件内容。
"""
import os
import sqlite3
import sys

DATA = r'E:\CharacterLibrary'
DB = os.path.join(DATA, '.catalog', 'library.db')

OLD_REAL = '角色库'      # 有数据、放真人
NEW_REAL = '人物库'
OLD_FAKE = '人物库'      # 空的、给虚拟角色
NEW_FAKE = '角色库'
TMP = '__swap_tmp'

# 1) 交换目录（用中转名避开重名）
p_real = os.path.join(DATA, OLD_REAL)
p_fake = os.path.join(DATA, OLD_FAKE)
p_tmp = os.path.join(DATA, TMP)

for p in (p_real, p_fake):
    if not os.path.isdir(p):
        sys.exit(f'目录不存在，中止：{p}')
if os.path.exists(p_tmp):
    sys.exit(f'中转目录已存在，中止：{p_tmp}')

os.rename(p_fake, p_tmp)     # 空的 人物库 -> 中转
os.rename(p_real, p_fake)    # 角色库(有数据) -> 人物库
os.rename(p_tmp, p_real)     # 中转 -> 角色库
print('目录已交换')
for d in sorted(os.listdir(DATA)):
    full = os.path.join(DATA, d)
    if os.path.isdir(full) and not d.startswith('.'):
        n = sum(len(f) for _, _, f in os.walk(full))
        print(f'  {d:<10} {n} 个文件')

# 2) 数据库
db = sqlite3.connect(DB)
cols = [r[1] for r in db.execute('PRAGMA table_info(shelves)')]
if 'kind' not in cols:
    db.execute("ALTER TABLE shelves ADD COLUMN kind TEXT NOT NULL DEFAULT 'people'")
    print('已加 shelves.kind 列')

rows = list(db.execute('SELECT id, name FROM shelves ORDER BY id'))
print('迁移前 shelves:', rows)

# 按当前名字判断谁是谁（避免用 id 写死）
for sid, name in rows:
    if name == OLD_REAL:
        db.execute("UPDATE shelves SET name=?, kind='people' WHERE id=?", (NEW_REAL, sid))
    elif name == OLD_FAKE:
        db.execute("UPDATE shelves SET name=?, kind='work' WHERE id=?", (NEW_FAKE, sid))

# 3) 路径前缀：所有现存角色/媒体都在原「角色库」下
db.execute(
    "UPDATE characters SET dir_slug = ? || substr(dir_slug, ?) WHERE dir_slug LIKE ?",
    (NEW_REAL + '/', len(OLD_REAL) + 2, OLD_REAL + '/%'),
)
db.execute(
    "UPDATE media SET rel_path = ? || substr(rel_path, ?) WHERE rel_path LIKE ?",
    (NEW_REAL + '/', len(OLD_REAL) + 2, OLD_REAL + '/%'),
)
db.commit()

print('迁移后 shelves:', list(db.execute('SELECT id, name, kind FROM shelves ORDER BY id')))
print('角色目录前缀分布:', list(db.execute(
    "SELECT DISTINCT substr(dir_slug,1,instr(dir_slug,'/')-1) FROM characters")))
print('媒体路径前缀分布:', list(db.execute(
    "SELECT substr(rel_path,1,instr(rel_path,'/')-1) p, COUNT(*) FROM media GROUP BY p")))

# 4) 逐条核对文件是否真的存在
missing = []
for (rel,) in db.execute('SELECT rel_path FROM media'):
    if not os.path.isfile(os.path.join(DATA, *rel.split('/'))):
        missing.append(rel)
print('文件缺失:', len(missing))
for m in missing[:5]:
    print('  !', m)
db.close()

if missing:
    sys.exit('存在缺失文件，请检查后再继续')
print('迁移完成，路径与磁盘一致')
