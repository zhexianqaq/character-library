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

export function aspectStyle(w, h, fallback = 3 / 4) {
  const ar = w && h ? w / h : fallback;
  return `--ar:${ar.toFixed(5)}`;
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

/** 让图片淡入，避免加载完成时闪一下 */
export function fadeIn(img) {
  if (!img) return;
  const mark = () => img.classList.add('loaded');
  if (img.complete && img.naturalWidth) mark();
  else {
    img.addEventListener('load', mark, { once: true });
    img.addEventListener('error', mark, { once: true });
  }
}
