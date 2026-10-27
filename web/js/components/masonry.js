import { api } from '../api.js';
import { aspectStyle, columnCount, splitColumns, layoutSpanned, fadeIn, fmtDur, esc } from '../util.js';

const COL_W = 120;
const GAP = 8;

/** geo 有值时走跨列布局（绝对定位，像素由 layoutSpanned 算），否则交给 aspect-ratio 自己撑高 */
function tileHtml(it, opts = {}, geo = null) {
  const isVideo = it.kind === 'video';
  const fallback = isVideo ? 16 / 9 : 3 / 4;
  const picked = typeof opts.isPicked === 'function' ? opts.isPicked(it) : false;
  const box = geo
    ? `left:${geo.x}px;top:${geo.y}px;width:${geo.w}px;height:${geo.h}px`
    : aspectStyle(it.width, it.height, fallback);
  return `<button class="tile${geo ? '' : ' ratio'}${picked ? ' is-sel' : ''}" style="${box}"
      data-id="${it.id}" data-anim="${!isVideo && it.anim ? 1 : 0}">
    <img src="${api.thumb(it.id)}" alt="${esc(it.fileName)}" loading="lazy" decoding="async">
    ${isVideo ? VIDEO_BADGE : ''}
    ${!isVideo && it.anim ? '<span class="gif">GIF</span>' : ''}
    ${isVideo && it.durationMs ? `<span class="dur">${fmtDur(it.durationMs)}</span>` : ''}
    ${opts.selectable ? '<span class="tick" aria-hidden="true"></span>' : ''}
  </button>`;
}

/**
 * 视频角标：右上角一个小图标就够了。
 * 以前是盖在正中间的大播放键 + 底部黑渐变 —— 竖屏封面正好把脸挡住，
 * 而且瓦片本来就点得开，不需要再喊一次「这里有视频」。
 * 9px 见方里画「方框 + 三角」会糊成一团，所以只用一枚实心三角。
 */
const VIDEO_BADGE = `<span class="vtag" title="视频" aria-label="视频">
  <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
    <path d="M2.6 1.9l5.3 3.1-5.3 3.1z" fill="currentColor"/>
  </svg>
</span>`;

/* ── 悬停播放（只给动图）──────────────────────────────────
   停 420ms 后把这一张的缩略图换成 gif 原件播放，并轻微放大；
   移开就换回缩略图。同一时刻只有一个瓦片在动，开销就是一个 <img>。
   刻意不做「所有动图自动播放」：上千个瓦片一起解码会直接卡死。

   **视频不参与**：以前视频的 anim 也是 true，跟着走了这条路径 ——
   悬停就把整个 mp4 原件当图片塞进 <img> 里解码，既播不出来又白烧 IO/内存。 */
const HOVER_DELAY = 420;
let hoverTimer = 0;
let liveTile = null;
let guarded = false;

function stopLive() {
  clearTimeout(hoverTimer);
  hoverTimer = 0;
  if (!liveTile) return;
  const img = liveTile.querySelector('img');
  if (img && liveTile.dataset.thumb) img.src = liveTile.dataset.thumb;
  liveTile.classList.remove('is-live');
  liveTile = null;
}

function guardStop() {
  if (guarded) return;
  guarded = true;
  // 滚动时瓦片会移位，继续播放体验很差；直接停
  window.addEventListener('scroll', stopLive, { passive: true, capture: true });
}

function bindHoverPlay(container, opts) {
  if (opts.selectable) return;
  guardStop();
  container.querySelectorAll('.tile[data-anim="1"]').forEach((el) => {
    const img = el.querySelector('img');
    if (!img) return;
    el.dataset.thumb = img.getAttribute('src') || '';
    el.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!el.isConnected) return;
        stopLive();
        const next = el.querySelector('img');
        if (!next) return;
        liveTile = el;
        el.classList.add('is-live');
        next.src = api.original(el.dataset.id);
      }, HOVER_DELAY);
    });
    el.addEventListener('mouseleave', stopLive);
  });
}

/**
 * 渲染瀑布流。列数按容器宽度决定；图片用各自宽高比占位，不裁剪。
 * onOpen(indexInItems) 回调由调用方决定灯箱范围。
 * opts.selectable / opts.isPicked 用来支持多选。
 * opts.spanWide = true 时启用跨列布局：宽/高 > WIDE_AR(1.7) 的素材占两列（人物库 / 角色库用）。
 */
export function renderMasonry(container, items, onOpen, opts = {}) {
  stopLive();
  const cols = columnCount(container.clientWidth, COL_W, GAP);
  if (opts.spanWide) {
    const { placed, height } = layoutSpanned(items, cols, COL_W, GAP);
    container.classList.add('is-spanned');
    container.style.height = `${height}px`;
    container.innerHTML = placed.map((p) => tileHtml(p.it, opts, p)).join('');
  } else {
    container.classList.remove('is-spanned');
    container.style.removeProperty('height');
    const buckets = splitColumns(items, cols);
    container.innerHTML = buckets
      .map((col) => `<div class="col">${col.map((it) => tileHtml(it, opts)).join('')}</div>`)
      .join('');
  }

  container.querySelectorAll('img').forEach(fadeIn);
  bindHoverPlay(container, opts);

  container.querySelectorAll('.tile').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const id = Number(el.dataset.id);
      const index = items.findIndex((x) => x.id === id);
      // 把事件传出去：选取模式里要看 Shift / Ctrl
      if (onOpen) onOpen(index >= 0 ? index : 0, ev);
    });
    if (opts.onContext) {
      el.addEventListener('contextmenu', (e) => {
        const id = Number(el.dataset.id);
        const index = items.findIndex((x) => x.id === id);
        opts.onContext(e, items[index >= 0 ? index : 0], index >= 0 ? index : 0);
      });
    }
  });
}

/** 窗口宽度变化导致列数改变时重排 */
export function watchMasonryLayout(container, getItems, getOnOpen, getOpts) {
  let lastCols = columnCount(container.clientWidth);
  const onResize = () => {
    const next = columnCount(container.clientWidth);
    if (next !== lastCols) {
      lastCols = next;
      const items = getItems();
      if (items && items.length) renderMasonry(container, items, getOnOpen(), getOpts ? getOpts() : {});
    }
  };
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}
