import { api } from '../api.js';
import { esc, toast } from '../util.js';
import { escDepth } from '../esc.js';

/**
 * 漫画阅读器：上下连续滚动。
 *
 * 页序来自 media.page_no（转换时按文件名自然序写死），和图包的排序设置无关 ——
 * 改「图包按大小排序」不会把漫画的第 3 页变成第 1 页。
 *
 * 几百页不能一次全插 <img>：容器按数据库里的宽高先占位（所以滚动条长度一开始就是对的），
 * 图片交给 IntersectionObserver 在进入视野前 1200px 才设 src。
 */

const posKey = (id) => `cl-comic:${id}`;

function loadPos(id) {
  try {
    return Number(JSON.parse(localStorage.getItem(posKey(id)) || 'null') || 0);
  } catch {
    return 0;
  }
}
function savePos(id, page) {
  try {
    localStorage.setItem(posKey(id), JSON.stringify(page));
  } catch {
    /* ignore */
  }
}

export async function ComicView(root, packId) {
  const id = Number(packId);
  let pack;
  let data;
  try {
    [pack, data] = await Promise.all([api.pack(id), api.packMedia(id)]);
  } catch (err) {
    root.innerHTML = `<main class="page"><div class="empty"><b>打不开这本漫画</b>${esc(
      err.message || ''
    )}</div></main>`;
    return;
  }
  const pages = (data.items || []).filter((m) => m.kind === 'image');
  const back = () => {
    // 从图包页点进来的就原路退（保留那边的滚动位置）；直接开链接进来的才推一条
    if (history.state && history.state.from) {
      history.back();
      return;
    }
    history.pushState({}, '', `/p/${id}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  };

  if (!pages.length) {
    root.innerHTML = `<main class="page"><div class="empty"><b>这本漫画还没有页</b>往图包里添加图片后会按文件名排页序</div></main>`;
    return;
  }

  root.innerHTML = `
    <div class="comic">
      <header class="reader-bar comic-bar">
        <button class="rb-btn" data-back aria-label="返回图包">‹</button>
        <div class="rb-text">
          <div class="rb-name">${esc(pack.title)}</div>
          <div class="rb-meta" data-meta>1 / ${pages.length}</div>
        </div>
        <span class="spacer"></span>
        <button class="rb-btn" data-top>顶部</button>
      </header>
      <div class="cm-strip" data-strip>
        ${pages
          .map((m, i) => {
            const ratio = m.width && m.height ? `${m.width} / ${m.height}` : '';
            return `<div class="cm-page" data-i="${i}" data-id="${m.id}"${
              ratio ? ` style="aspect-ratio:${ratio}"` : ''
            }>
              ${ratio ? '' : '<div class="cm-ph"></div>'}
              <img alt="${esc(m.fileName || '')}" decoding="async">
              <span class="cm-no">${i + 1}</span>
            </div>`;
          })
          .join('')}
      </div>
    </div>`;

  const strip = root.querySelector('[data-strip]');
  const metaEl = root.querySelector('[data-meta]');
  const tiles = [...strip.querySelectorAll('.cm-page')];

  // 图片预览是 1200px 宽的 webp，读漫画够用；原图留给「在大图里看」
  const load = (el) => {
    const img = el.querySelector('img');
    if (!img || img.dataset.on) return;
    img.dataset.on = '1';
    img.addEventListener('load', () => el.classList.add('is-loaded'), { once: true });
    img.src = api.preview(Number(el.dataset.id));
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          load(e.target);
          // 顺带预取前后各一页，快速下滚不空屏
          const i = Number(e.target.dataset.i);
          if (tiles[i - 1]) load(tiles[i - 1]);
          if (tiles[i + 1]) load(tiles[i + 1]);
        }
      }
    },
    { rootMargin: '1200px 0px' }
  );
  tiles.forEach((el) => io.observe(el));

  let cur = 1;
  const setCur = (n, save = true) => {
    if (n === cur) return;
    cur = n;
    metaEl.textContent = `${n} / ${pages.length}`;
    if (save) savePos(id, n);
  };

  /* 每页的 scrollY 位置只量一次（图片有宽高占位，量完不会变）。
     滚动里逐页 getBoundingClientRect 会反复触发布局，300 页时肉眼可见地卡。 */
  let offsets = [];
  const measure = () => {
    offsets = tiles.map((el) => el.offsetTop);
  };
  const pageTop = (i) => (offsets[i] != null ? offsets[i] : tiles[i].offsetTop);
  const gotoPage = (i) => {
    const n = Math.min(pages.length, Math.max(1, i + 1));
    window.scrollTo({ top: Math.max(0, pageTop(n - 1) - 8), behavior: 'auto' });
    setCur(n);
  };

  /** 当前页 = 最后一个「顶部已经滚过视口上沿 1/3」的那页 */
  const onScroll = () => {
    const probe = window.scrollY + window.innerHeight * 0.34;
    let n = 1;
    for (let i = 0; i < tiles.length; i += 1) {
      if (pageTop(i) <= probe) n = i + 1;
      else break;
    }
    setCur(n, true);
  };
  let scrollTimer = 0;
  const onScrollThrottled = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(onScroll, 90);
  };
  window.addEventListener('scroll', onScrollThrottled, { passive: true });

  // 从 ?p=12 或上次读到的位置继续；没有就从头开始
  const want = Number(new URLSearchParams(location.search).get('p')) || loadPos(id) || 1;
  setCur(Math.min(pages.length, Math.max(1, want)), false);
  requestAnimationFrame(() => {
    measure();
    window.scrollTo(0, Math.max(0, pageTop(cur - 1) - 8));
    onScroll();
  });
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, 200);
  };
  window.addEventListener('resize', onResize);

  root.querySelector('[data-back]').addEventListener('click', back);
  root.querySelector('[data-top]').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
    if (escDepth() > 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      gotoPage(cur);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      gotoPage(cur - 2);
    }
  };
  document.addEventListener('keydown', onKey);
  document.title = `${pack.title} · 阅读`;

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScrollThrottled);
    io.disconnect();
    clearTimeout(scrollTimer);
    clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
  };
}
