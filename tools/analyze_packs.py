"""第二轮只读分析：验证图包切分粒度（按帖子 vs 按日期），以及视频命名规律。"""
import os, re, json
from pathlib import Path
from collections import Counter, defaultdict

ROOT = Path(r"E:\X-Vault珍藏馆")
IMG = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic'}
VID = {'.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.m4v', '.flv'}

DATE_RE = re.compile(r'(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])')
POST_RE = re.compile(r'^(.+?)-(\d{8})-(\d{6,})(?:_(\d{1,3}))?$')

date_group_sizes = Counter()
post_group_sizes = Counter()
vid_style = Counter()
img_style = Counter()
no_date = []
zip_list = []
date_per_role = []
post_per_role = []
total_media = 0

for role in sorted(ROOT.iterdir()):
    if not role.is_dir():
        continue
    by_date = defaultdict(list)
    by_post = defaultdict(list)
    media = 0
    for cur, _, fs in os.walk(role):
        for f in fs:
            ext = os.path.splitext(f)[1].lower()
            full = os.path.join(cur, f)
            if ext == '.zip':
                try:
                    zip_list.append((role.name, f, os.stat(full).st_size))
                except OSError:
                    pass
                continue
            if ext not in IMG and ext not in VID:
                continue
            media += 1
            total_media += 1
            stem = os.path.splitext(f)[0]
            m = POST_RE.match(stem)
            if m:
                by_post[f"{m.group(2)}-{m.group(3)}"].append(f)
                (img_style if ext in IMG else vid_style)['post-style'] += 1
            else:
                by_post[stem].append(f)
                (img_style if ext in IMG else vid_style)['other'] += 1
            d = DATE_RE.search(stem)
            if d:
                by_date[d.group(0)].append(f)
            else:
                no_date.append(f"{role.name}/{f}")
    for v in by_date.values():
        date_group_sizes[len(v)] += 1
    for v in by_post.values():
        post_group_sizes[len(v)] += 1
    date_per_role.append((role.name, media, len(by_date), len(by_post)))
    post_per_role.append(len(by_post))

def hist(counter, upto=12):
    ks = sorted(k for k in counter if isinstance(k, int))
    out = []
    acc = 0
    for k in ks:
        acc += counter[k]
        if k <= upto or k in (ks[-1],):
            out.append([k, counter[k]])
    return out, acc

dh, dtot = hist(date_group_sizes)
ph, ptot = hist(post_group_sizes)

summary = {
    "total_media": total_media,
    "date_groups_total": dtot,
    "post_groups_total": ptot,
    "date_group_size_hist": dh,
    "post_group_size_hist": ph,
    "date_groups_per_role": {
        "min": min(x[2] for x in date_per_role),
        "max": max(x[2] for x in date_per_role),
        "avg": round(sum(x[2] for x in date_per_role) / len(date_per_role), 1),
    },
    "post_groups_per_role": {
        "min": min(x[3] for x in date_per_role),
        "max": max(x[3] for x in date_per_role),
        "avg": round(sum(x[3] for x in date_per_role) / len(date_per_role), 1),
    },
    "media_per_date_group_avg": round(total_media / dtot, 1) if dtot else 0,
    "media_per_post_group_avg": round(total_media / ptot, 1) if ptot else 0,
    "img_name_style": dict(img_style),
    "vid_name_style": dict(vid_style),
    "files_without_date": len(no_date),
    "no_date_samples": no_date[:10],
    "zip_count": len(zip_list),
    "zip_total_mb": round(sum(z[2] for z in zip_list) / 1024 ** 2, 1),
    "zip_samples": [[z[0], z[1][:60], round(z[2] / 1024 ** 2, 1)] for z in zip_list[:8]],
    "top_roles_by_dategroups": sorted(date_per_role, key=lambda x: -x[2])[:6],
}
print(json.dumps(summary, ensure_ascii=False, indent=1))
