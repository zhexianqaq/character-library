import { api } from '../api.js';
import { aspectStyle, columnCount, splitColumns, fadeIn, fmtDur, esc } from '../util.js';

function tileHtml(it) {
  const isVideo = it.kind === 'video';
  const fallback = isVideo ? 16 / 9 : 3 / 4;
  return `<button class="tile ratio" style="${aspectStyle(it.width, it.height, fallback)}" data-id="${it.id}">
    <img src="${api.thumb(it.id)}" alt="${esc(it.fileName)}" loading="lazy" decoding="async">
    ${isVideo ? '<span class="play"><i></i></span>' : ''}
    ${isVideo && it.durationMs ? `<span class="dur">${fmtDur(it.durationMs)}</span>` : ''}
  </button>`;
}

/**
 * 渲染瀑布流。列数按容器宽度决定；图片用各自宽高比占位，不裁剪。
 * onOpen(indexInItems) 回调由调用方决定灯箱范围。
 */
export function renderMasonry(container, items, onOpen, opts = {}) {
  const cols = columnCount(container.clientWidth);
  const buckets = splitColumns(items, cols);
  container.innerHTML = buckets
    .map((col) => `<div class="col">${col.map(tileHtml).join('')}</div>`)
    .join('');

  container.querySelectorAll('img').forEach(fadeIn);

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
