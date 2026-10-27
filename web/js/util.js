export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

export function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(0)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

export function fmtDur(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function debounce(fn, wait = 220) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

let toastTimer = null;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

/**
 * 批量删除之后说什么。
 * 后端的 `failed` 里每项都有原因（占用 / 只读 / 路径不对），只说「已删除 N 个」
 * 会让「删了 3 个、其实 1 个还在磁盘上」看起来像全部成功。
 */
export function deleteSummary(res, noun, verb = '删除') {
  const done = res && typeof res.done === 'number' ? res.done : 0;
  const failed = (res && Array.isArray(res.failed) && res.failed) || [];
  if (!failed.length) return `已${verb} ${done} 个${noun}`;
  const why = failed[0] && failed[0].reason ? `：${failed[0].reason}` : '';
  return `已${verb} ${done} 个${noun}，${failed.length} 个失败${why}`;
}

/** 删条目之后说什么：目录没删干净必须讲出来，不能只说「已删除」 */
export function charDeleteMessage(res) {
  if (res && res.dirRemoved === false && res.warning) return res.warning;
  return '已删除';
}

/**
 * 复制文本。http 页面（非 secure context）没有 navigator.clipboard，
 * 所以要留一条 textarea + execCommand 的降级路径。
 */
export async function copyText(text) {
  const val = String(text == null ? '' : text);
  if (!val) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(val);
      return true;
    }
  } catch {
    /* 走降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, val.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function aspectStyle(w, h, fallback = 3 / 4) {
  const ar = w && h ? w / h : fallback;
  return `--ar:${ar.toFixed(5)}`;
}

/**
 * 超宽素材的判定线：宽/高 > 1.4（也就是高宽比小于 1:1.4）。
 * 这条线要能收下 16:9（1.78）——视频和手机横拍基本都是这个比例，
 * 放一列只有 67px 高，细节全糊；占两列才有辨识度。
 */
export const WIDE_AR = 1.4;

/** 瓦片宽高比；没尺寸信息时按类型给个保底值（和缩略图占位一致） */
export function tileAspect(it) {
  if (it && it.width && it.height) return it.width / it.height;
  return it && it.kind === 'video' ? 16 / 9 : 3 / 4;
}

/**
 * 支持「超宽项跨两列」的瀑布流：列宽固定，超宽项占 2 列（= 2 列 + 1 个间隙），
 * 每次放进当前最矮的一列（超宽项放最矮的相邻两列），返回像素坐标。
 * 用绝对定位而不是 flex 列，是为了让宽项真的跨过两列、且两个方向的间隙都是同一个值。
 */
export function layoutSpanned(items, cols, colW = 120, gap = 8, wideAr = WIDE_AR) {
  const n = Math.max(1, cols);
  const heights = new Array(n).fill(0);
  const placed = [];
  let height = 0;

  for (const it of items) {
    const ar = tileAspect(it);
    const span = n > 1 && ar > wideAr ? 2 : 1;
    const w = span * colW + (span - 1) * gap;
    const h = Math.round(w / ar);
    let col = 0;
    let top = 0;

    if (span === 1) {
      for (let i = 1; i < n; i += 1) if (heights[i] < heights[col]) col = i;
      top = heights[col];
      heights[col] = top + h + gap;
    } else {
      let bestScore = Infinity;
      for (let i = 0; i + span <= n; i += 1) {
        // 打分 = 2×两列较高的那个 − 较矮的那个（也就是 max + 高低差）：
        // 先要「放得靠上」，其次要「两列齐平」。只按 max 挑的话会挑到一高一矮的相邻列，
        // 矮的那列上方会留一个大空洞（16:9 变多以后特别明显）。
        const lo = Math.min(heights[i], heights[i + 1]);
        const hi = Math.max(heights[i], heights[i + 1]);
        const score = 2 * hi - lo;
        if (score < bestScore) {
          col = i;
          bestScore = score;
          top = hi;
        }
      }
      heights[col] = top + h + gap;
      heights[col + 1] = top + h + gap;
    }

    placed.push({ it, x: col * (colW + gap), y: top, w, h });
    if (top + h > height) height = top + h;
  }

  return { placed, height };
}

/**
 * 估算瀑布流：已知宽高比时按「最短列优先」分配，保证从左到右的视觉顺序
 * 且各列高度基本齐平。返回每列的条目数组。
 */
export function splitColumns(items, cols) {
  const heights = new Array(cols).fill(0);
  const buckets = Array.from({ length: cols }, () => []);
  for (const it of items) {
    const ar = it.width && it.height ? it.width / it.height : 3 / 4;
    const h = 1 / ar;
    let target = 0;
    for (let i = 1; i < cols; i += 1) {
      if (heights[i] < heights[target]) target = i;
    }
    buckets[target].push(it);
    heights[target] += h + 0.05;
  }
  return buckets;
}

/** 瀑布流列数：列宽固定（默认 120px），算得下几列就排几列 */
export function columnCount(width, colW = 120, gap = 8) {
  return Math.max(1, Math.floor((width + gap) / (colW + gap)));
}

/**
 * 别名拆分：「FGO、Fate/Grand Order」→ ['FGO','Fate/Grand Order']。
 * 中英文逗号、顿号、分号、换行都算分隔符；数组直接洗一遍。
 */
export function splitAliases(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[,，、;；\n]+/);
  const out = [];
  for (const x of raw) {
    const t = String(x || '').trim().slice(0, 60);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

/** 让图片淡入，避免加载完成时闪一下 */
/**
 * 重画列表时保住滚动位置。
 *
 * 进入 / 退出选取会整块重画，分片渲染又是分几帧插卡片的：
 * 先等两帧（容器高度已经撑好）对齐一次，再兜底一次。
 */
export function keepScroll(fn) {
  const y = window.scrollY;
  const restore = () => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => window.scrollTo(0, y))
    );
  };
  const ret = fn();
  if (ret && typeof ret.then === 'function') ret.then(restore, restore);
  else restore();
  // 分片渲染要几帧才铺完，最后再兜底对齐一次
  setTimeout(() => {
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
  }, 160);
}

export function fadeIn(img) {  if (!img) return;
  const mark = () => img.classList.add('loaded');
  if (img.complete && img.naturalWidth) mark();
  else {
    img.addEventListener('load', mark, { once: true });
    img.addEventListener('error', mark, { once: true });
  }
}
