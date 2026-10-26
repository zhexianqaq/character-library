import { api } from '../api.js';
import { aspectStyle, columnCount, splitColumns, fadeIn, fmtDur, esc } from '../util.js';

function tileHtml(it, opts = {}) {
  const isVideo = it.kind === 'video';
  const fallback = isVideo ? 16 / 9 : 3 / 4;
  const picked = typeof opts.isPicked === 'function' ? opts.isPicked(it) : false;
  return `<button class="tile ratio${picked ? ' is-sel' : ''}" style="${aspectStyle(it.width, it.height, fallback)}"
      data-id="${it.id}" data-anim="${it.anim ? 1 : 0}">
    <img src="${api.thumb(it.id)}" alt="${esc(it.fileName)}" loading="lazy" decoding="async">
    ${isVideo ? '<span class="play"><i></i></span>' : ''}
    ${!isVideo && it.anim ? '<span class="gif">GIF</span>' : ''}
    ${isVideo && it.durationMs ? `<span class="dur">${fmtDur(it.durationMs)}</span>` : ''}
    ${opts.selectable ? '<span class="tick" aria-hidden="true"></span>' : ''}
  </button>`;
}

/* ── 悬停播放 ──────────────────────────────────────────────
   停 420ms 后把这一张的缩略图换成 gif 原件播放，并轻微放大；
   移开就换回缩略图。同一时刻只有一个瓦片在动，开销就是一个 <img>。
   刻意不做「所有动图自动播放」：上千个瓦片一起解码会直接卡死。 */
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
 */
export function renderMasonry(container, items, onOpen, opts = {}) {
  stopLive();
  const cols = columnCount(container.clientWidth);
  const buckets = splitColumns(items, cols);
  container.innerHTML = buckets
    .map((col) => `<div class="col">${col.map((it) => tileHtml(it, opts)).join('')}</div>`)
    .join('');

  container.querySelectorAll('img').forEach(fadeIn);
  bindHoverPlay(container, opts);

  container.querySelectorAll('.tile').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.id);
      const index = items.findIndex((x) => x.id === id);
      if (onOpen) onOpen(index >= 0 ? index : 0);
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
