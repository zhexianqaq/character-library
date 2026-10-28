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
    ${!isVideo && opts.showPage && it.pageNo ? `<span class="pno">${it.pageNo}</span>` : ''}
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

/** 分片单位：一帧最多往 DOM 里插这么多张。太小会一帧一闪，太大首屏就要等 */
const CHUNK = 80;

function bindHoverPlay(container, opts) {
  if (opts.selectable) return;
  guardStop();
  // 只绑还没绑过的：分片渲染会一批批进 DOM，全量重绑会让同一个瓦片挂上多个监听
  container.querySelectorAll('.tile[data-anim="1"]:not([data-hover])').forEach((el) => {
    el.dataset.hover = '1';
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

/** 给「还没绑过」的瓦片挂事件：分片插入的每一批都会走这里，已绑过的跳过 */
function bindFresh(container, items, indexById, onOpen, opts) {
  const fresh = container.querySelectorAll('.tile:not([data-bound])');
  if (!fresh.length) return;
  for (const el of fresh) {
    el.dataset.bound = '1';
    const id = Number(el.dataset.id);
    const index = indexById.has(id) ? indexById.get(id) : 0;
    el.addEventListener('click', (ev) => {
      // 把事件传出去：选取模式里要看 Shift / Ctrl
      if (onOpen) onOpen(index, ev);
    });
    if (opts.onContext) {
      el.addEventListener('contextmenu', (e) => {
        opts.onContext(e, items[index] || items[0], index);
      });
    }
    const img = el.querySelector('img');
    if (img) fadeIn(img);
  }
  bindHoverPlay(container, opts);
}

/**
 * 渲染瀑布流。列数按容器宽度决定；图片用各自宽高比占位，不裁剪。
 * onOpen(indexInItems) 回调由调用方决定灯箱范围。
 * opts.selectable / opts.isPicked 用来支持多选。
 * opts.spanWide = true 时启用跨列布局：宽/高 > WIDE_AR(1.7) 的素材占两列（人物集 / 角色集用）。
 * opts.appendFrom = N 时只往已有网格后面补第 N 项之后的（「加载更多」用）——
 *   已经画好的卡片不再重建，跨列布局也只算一次位置（前面的位置不会因为追加而变）。
 *
 * 无论哪种模式，DOM 都是**分帧插入**的：几千张的包先出前 80 张，
 * 剩下的每帧补一批。一次 innerHTML 塞几千个瓦片会卡住主线程（连筛选条都点不动）。
 */
export function renderMasonry(container, items, onOpen, opts = {}) {
  stopLive();
  const list = Array.isArray(items) ? items : [];
  const cols = columnCount(container.clientWidth, COL_W, GAP);
  const token = (container._mtoken = (container._mtoken || 0) + 1);
  const indexById = new Map(list.map((x, i) => [x.id, i]));

  let from = Math.max(0, Number(opts.appendFrom) || 0);
  /**
   * 上一次渲染可能被新的 render 打断（token 被换掉），实际只画了一部分。
   * 这时调用方按「列表长度」算出来的 appendFrom 会跳过没画出来的那一段 ——
   * 连着点「加载更多」就会漏卡片（实测 360 项只见到 320 张）。
   * 以容器上记的实际进度为准，从真正画到的位置补。
   */
  const painted = Number(container._rendered) || 0;
  if (from > 0 && painted < from) from = painted;

  if (from > 0) {
    // 列数变了 / 上次不是这套布局：追加会错位，退回全量重画
    const colsOk = container.dataset.mcols === String(cols);
    const modeOk = opts.spanWide
      ? container.classList.contains('is-spanned')
      : container.querySelectorAll(':scope > .col').length === cols;
    if (!colsOk || !modeOk) from = 0;
  }
  container.dataset.mcols = String(cols);

  /**
   * 待插入队列：只存「哪一项、放哪、什么位置」，DOM 字符串等真正插入时才生成。
   * 提前把所有卡片的 HTML 算好会漏掉这期间的状态变化 ——
   * 分片还没画完时点「全选」，后面几批拿到的还是旧 HTML，于是计数 240 只勾上 80。
   */
  const jobs = [];
  if (opts.spanWide) {
    if (!from) {
      container.innerHTML = '';
      container.classList.add('is-spanned');
    }
    const { placed, height } = layoutSpanned(list, cols, COL_W, GAP);
    container.style.height = `${height}px`;
    for (const p of placed.slice(from)) jobs.push({ parent: container, it: p.it, geo: p });
  } else {
    if (!from) {
      container.classList.remove('is-spanned');
      container.style.removeProperty('height');
      container.innerHTML = Array.from({ length: cols }, () => '<div class="col"></div>').join('');
    }
    const buckets = splitColumns(list, cols);
    const colEls = [...container.children];
    for (let c = 0; c < buckets.length; c += 1) {
      const el = colEls[c];
      if (!el) continue;
      // 这一列已经画过 have 张（追加时不必重算前面的）
      const have = el.childElementCount;
      for (const it of buckets[c].slice(have)) jobs.push({ parent: el, it, geo: null });
    }
  }
  container._rendered = from;

  if (!jobs.length) {
    bindFresh(container, list, indexById, onOpen, opts);
    return;
  }

  const run = (startAt) => {
    if (container._mtoken !== token) return; // 被新的 render 取代了
    const end = Math.min(jobs.length, startAt + CHUNK);
    let parent = null;
    let batch = [];
    const flush = () => {
      if (batch.length && parent) parent.insertAdjacentHTML('beforeend', batch.join(''));
      batch = [];
    };
    for (let i = startAt; i < end; i += 1) {
      const j = jobs[i];
      if (j.parent !== parent) {
        flush();
        parent = j.parent;
      }
      // 现算现插：勾选 / 选取态在分片过程中变了，这一批也要跟上
      batch.push(tileHtml(j.it, opts, j.geo));
    }
    flush();
    // 跨列模式下 jobs 与 items 一一对应，这个数就是「已经画到第几项」
    if (opts.spanWide) container._rendered = from + end;
    bindFresh(container, list, indexById, onOpen, opts);
    if (end < jobs.length) requestAnimationFrame(() => run(end));
  };
  run(0);
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
