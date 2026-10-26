// 目录名 / 文件名解析：把素材的真实命名规律固化成可测的纯函数。
// 实测样本：'Aqua水淼(aqua_cosplay)-20210812-1425500871643697155_1.jpg'

const POST_RE = /^(.+?)-(\d{8})-(\d{6,})(?:_(\d{1,3}))?$/;
const DATE_RE = /(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/;
const SEQ_RE = /^(.*?)[_\-\s]+(\d{1,3})$/;
const DIR_ACCOUNT_RE = /^(.*)\(([^()]+)\)\s*$/;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.jfif', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.m4v', '.flv', '.ts', '.mpg', '.mpeg', '.3gp']);

export function kindOf(ext) {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (e === '.zip' || e === '.rar' || e === '.7z') return 'archive';
  return null;
}

function trimEdges(s) {
  return s.replace(/^[\s\-_·•]+/, '').replace(/[\s\-_·•]+$/, '').trim();
}

/** 'Aqua水淼(aqua_cosplay)' -> { name:'Aqua水淼', account:'aqua_cosplay' } */
export function parseDirName(dir) {
  const m = DIR_ACCOUNT_RE.exec(dir);
  if (m && m[1].trim()) {
    return { name: trimEdges(m[1]), account: m[2].trim() };
  }
  return { name: trimEdges(dir), account: null };
}

/**
 * 解析媒体文件名，得到图包归属。
 * 返回 { packKey, packDate, seq }
 * - 主路径：命中「名称-日期-帖子ID[_序号]」→ 一条帖子一个图包
 * - 兜底：只命中日期 → 按日期成包
 * - 都没有 → packKey='unsorted'
 */
export function parseMediaName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const m = POST_RE.exec(stem);
  if (m) {
    const ymd = m[2];
    return {
      packKey: `${ymd}-${m[3]}`,
      packDate: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      seq: m[4] ? Number(m[4]) : 0,
      style: 'post',
    };
  }
  const d = DATE_RE.exec(stem);
  if (d) {
    return {
      packKey: `date-${d[0]}`,
      packDate: `${d[1]}-${d[2]}-${d[3]}`,
      seq: 0,
      style: 'date',
    };
  }
  return { packKey: 'unsorted', packDate: null, seq: 0, style: 'none' };
}

/** 图包默认标题：用日期，同一天多个包时在 UI 上靠时间区分 */
export function defaultPackTitle(packDate, style) {
  if (packDate) return packDate;
  return style === 'none' ? '未归类' : '未命名';
}

/**
 * 素材实际是「一条帖子 1~4 张」的碎片，按帖子成包会让每包只剩 1 张。
 * 因此图包按「年-月」聚合，保证包内有足够内容撑起瀑布流；
 * 原始帖子 ID 另存 post_key，需要时可再拆回单条帖子。
 */
export function monthKeyOf(packDate) {
  return packDate ? packDate.slice(0, 7) : '0000-00';
}

export function monthTitle(packDate) {
  if (!packDate) return '未归类';
  const [y, m] = packDate.split('-');
  return `${y} 年 ${Number(m)} 月`;
}

/** 自然排序：让 _2 排在 _10 前面 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

/** 生成媒体短 ID：取相对路径的稳定哈希，重扫不变、改名即换 */
export function stableKey(relPath) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < relPath.length; i++) {
    const c = relPath.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12);
}
