import { createPackSort } from './pack-sort.js';

/** 图包里的媒体排序维度：名称 / 时间 / 大小 / 类型 */
export const MEDIA_SORT_KEYS = [
  { value: 'name', label: '名称' },
  { value: 'time', label: '时间' },
  { value: 'size', label: '大小' },
  { value: 'type', label: '类型' },
];

/** 默认名称升序：和入库顺序（按文件名）基本一致，也是文件名带日期时最直观的读法 */
export const MEDIA_SORT_DEFAULT = { key: 'name', desc: false };

/**
 * 当前排序偏好放模块级：换图包、进出详情页都沿用。
 * 图包页的控件写它，媒体详情页的 ← → 序列读它 —— 两边顺序必须一致，
 * 否则按「大小倒序」点开第一张，翻页却按文件名走，看着像乱跳。
 */
export const mediaSortState = { ...MEDIA_SORT_DEFAULT };

export function setMediaSort(key, desc) {
  mediaSortState.key = key;
  mediaSortState.desc = desc;
}

const nameOf = (m) => String((m && (m.fileName || m.title)) || '');

// 每张图都比一次，复用同一个 Collator 比每次 localeCompare 快得多（几千张的包差别明显）
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const cmpName = (a, b) => collator.compare(nameOf(a), nameOf(b));

/** 视频排在图片后面；类型排序下同一类里仍按名称走 */
const kindRank = (m) => (m && m.kind === 'video' ? 1 : 0);

/**
 * 时间键：优先取文件名里的日期（角色库是 `<角色>(<账号>)-<YYYYMMDD>-<帖子ID>`），
 * 没有就退回入库日期。统一截到「天」再比，两种来源才不会互相打架；
 * 同一天的文件再按名称升序，顺序稳定。
 */
function timeOf(m) {
  const name = nameOf(m);
  const hit = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(name);
  if (hit) {
    const mo = Number(hit[2]);
    const day = Number(hit[3]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) return `${hit[1]}-${hit[2]}-${hit[3]}`;
  }
  return String((m && m.createdAt) || '').slice(0, 10);
}

/**
 * 排图包里的媒体：返回新数组，不改原数组。
 *
 * 主键相同时**始终按名称升序**（次级排序不跟着倒序翻），
 * 这样同大小 / 同类型的几百张图不会每次渲染都换个位置。
 */
export function sortMedia(list, key = MEDIA_SORT_DEFAULT.key, desc = MEDIA_SORT_DEFAULT.desc) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const primary = (a, b) => {
    if (key === 'size') return (a.bytes || 0) - (b.bytes || 0);
    if (key === 'type') return kindRank(a) - kindRank(b);
    if (key === 'time') return timeOf(a).localeCompare(timeOf(b));
    return cmpName(a, b);
  };
  arr.sort((a, b) => {
    const r = primary(a, b) * (desc ? -1 : 1);
    return r !== 0 ? r : cmpName(a, b);
  });
  return arr;
}

/** 排序控件（外观与图包排序完全一致，只是维度换成媒体那四种） */
export function createMediaSort({
  key = mediaSortState.key,
  desc = mediaSortState.desc,
  onChange = null,
} = {}) {
  return createPackSort({ key, desc, keys: MEDIA_SORT_KEYS, onChange });
}
