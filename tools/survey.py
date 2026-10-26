"""只读扫描 E:\\X-Vault珍藏馆，统计素材实况。不写入、不移动任何源文件。"""
import os, json, re, time
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"E:\X-Vault珍藏馆")
OUT = Path(__file__).with_name("survey.json")

IMG = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.jfif', '.tif', '.tiff'}
VID = {'.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.m4v', '.flv', '.ts', '.mpg', '.mpeg', '.3gp'}

SEQ_RE = re.compile(r'^(.*?)[_\-\s]+(\d{1,3})$')
DATE_ID_RE = re.compile(r'^(?P<name>.+?)-(?P<date>\d{8})-(?P<pid>\d{6,})$')

t0 = time.time()
roles = []
ext_counter = Counter()
pack_sizes = Counter()
all_files = 0
all_bytes = 0
matched_seq = 0
other_files = []

for role_dir in sorted(ROOT.iterdir()):
    if not role_dir.is_dir():
        continue
    r = {
        "name": role_dir.name,
        "subdirs": [],
        "files": 0,
        "images": 0,
        "videos": 0,
        "others": 0,
        "bytes": 0,
    }
    packs = defaultdict(list)
    sub_counter = Counter()
    for cur, dirs, files in os.walk(role_dir):
        rel = os.path.relpath(cur, role_dir)
        if rel != '.':
            sub_counter[rel.split(os.sep)[0]] += 1
        for f in files:
            p = os.path.join(cur, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            ext = os.path.splitext(f)[1].lower()
            ext_counter[ext] += 1
            r["files"] += 1
            r["bytes"] += st.st_size
            all_files += 1
            all_bytes += st.st_size
            if ext in IMG:
                r["images"] += 1
            elif ext in VID:
                r["videos"] += 1
            else:
                r["others"] += 1
                if len(other_files) < 40:
                    other_files.append(rel + os.sep + f)
            stem = os.path.splitext(f)[0]
            m = SEQ_RE.match(stem)
            if m:
                packs[m.group(1)].append(st.st_size)
                matched_seq += 1
            else:
                packs[stem].append(st.st_size)
    r["subdirs"] = [k for k, _ in sub_counter.most_common()]
    r["pack_count"] = len(packs)
    for k, v in packs.items():
        pack_sizes[len(v)] += 1
    r["pack_size_sample"] = sorted((len(v) for v in packs.values()), reverse=True)[:5]
    # 命名规律判定：抽 3 个 pack key 看是否命中「名称-日期-帖子ID」
    hits = sum(1 for k in list(packs)[:200] if DATE_ID_RE.match(k))
    r["date_id_ratio"] = round(hits / min(len(packs), 200), 3) if packs else 0
    roles.append(r)

roles.sort(key=lambda x: -x["files"])
summary = {
    "root": str(ROOT),
    "role_count": len(roles),
    "total_files": all_files,
    "total_bytes": all_bytes,
    "total_gb": round(all_bytes / 1024 ** 3, 2),
    "images": sum(r["images"] for r in roles),
    "videos": sum(r["videos"] for r in roles),
    "others": sum(r["others"] for r in roles),
    "total_packs": sum(r["pack_count"] for r in roles),
    "seq_matched_files": matched_seq,
    "ext_top": ext_counter.most_common(20),
    "pack_size_hist": sorted(pack_sizes.items())[:25],
    "avg_files_per_role": round(all_files / len(roles), 1) if roles else 0,
    "avg_packs_per_role": round(sum(r["pack_count"] for r in roles) / len(roles), 1) if roles else 0,
    "max_files_in_role": roles[0] if roles else None,
    "min_files_in_role": roles[-1] if roles else None,
    "roles_with_subdirs": sum(1 for r in roles if r["subdirs"]),
    "other_ext_samples": other_files,
    "elapsed_sec": round(time.time() - t0, 1),
}
OUT.write_text(json.dumps({"summary": summary, "roles": roles}, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False, indent=1))
