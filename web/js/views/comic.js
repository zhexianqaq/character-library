import { api } from '../api.js';
import { esc, toast } from '../util.js';
import { escDepth } from '../esc.js';

/**
 * 漫画阅读器。
 *
 * 三种看法，各管一种场景：
 *   滚动 —— 上下连续，适合条漫 / 快速通读
 *   单页 —— 一屏一页，适合认真看细节
 *   双页 —— 左右对开，封面单独成页，适合跨页大图
 *
 * 方向（左→右 / 右→左）只影响单页、双页的按键与点击区：日漫按右→左读，
 * 此时「下一页」在左边，方向键也要跟着翻过来。
 *
 * 控件位置会自己找地方：舞台两侧有空白（页面没占满宽度）时，收起顶栏、
 * 把返回 / 页码 / 进度与模式 / 方向 / 适应 / 全屏竖排到左右两条侧栏上；
 * 页面顶满宽度时退回顶部胶囊 + 底部滑块。判断靠实测页面宽度，不看屏幕宽度 ——
 * 双页对开时页面经常是满的，那时侧栏会盖住画。
 *
 * 全屏是把 <html> 整个放进全屏，而不是 .comic 自己：
 * 元素自己进全屏后文档不再滚动，滚动模式下滚轮会失效。
 */

const posKey = (id) => `cl-comic:${id}`;
const prefsKey = 'cl-comic:prefs';

const MODES = [
  { v: 'scroll', label: '滚动' },
  { v: 'single', label: '单页' },
  { v: 'spread', label: '双页' },
];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefsKey) || 'null') || {};
    return {
      mode: MODES.some((m) => m.v === p.mode) ? p.mode : 'scroll',
      dir: p.dir === 'rtl' ? 'rtl' : 'ltr',
      fit: p.fit === 'width' ? 'width' : 'height',
    };
  } catch {
    return { mode: 'scroll', dir: 'ltr', fit: 'height' };
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(prefsKey, JSON.stringify(p));
  } catch {
    /* 隐私模式写不了就只在本次会话里生效 */
  }
}

function loadPos(id) {
  try {
    return Number(JSON.parse(localStorage.getItem(posKey(id)) || 'null')) || 0;
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

const ratioOf = (m) => (m.width && m.height ? `${m.width} / ${m.height}` : '');

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

  // 已经是普通图包了（比如转回图包后还开着旧链接）：退回图包页，别硬拿它当漫画读
  if ((pack.kind || 'pack') !== 'comic') {
    root.innerHTML = '<main class="page"><div class="empty"><b>这个图包不是漫画</b>正在回到图包页…</div></main>';
    setTimeout(() => {
      history.replaceState({}, '', `/p/${id}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    }, 0);
    return;
  }

  const pages = (data.items || []).filter((m) => m.kind === 'image');
  const total = pages.length;
  if (!total) {
    root.innerHTML = `<main class="page"><div class="empty"><b>这本漫画还没有页</b>往图包里添加图片后会按文件名排页序</div></main>`;
    return;
  }

  const prefs = loadPrefs();
  let mode = prefs.mode;
  let dir = prefs.dir;
  let fit = prefs.fit;
  let cur = 1;

  // 单页 / 双页的按键与点击区都按方向翻：右→左时「下一页」在左边
  const nextKey = () => (dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
  const prevKey = () => (dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft');

  /** 双页对开的分组：第 1 页单独（封面），之后 (2,3) (4,5) … */
  const spreads = (() => {
    const out = [];
    let i = 0;
    if (total > 1) {
      out.push([0]);
      i = 1;
    }
    while (i < total) {
      out.push(i + 1 < total ? [i, i + 1] : [i]);
      i += 2;
    }
    return out;
  })();

  const spreadIndexAt = (page) => {
    const pi = page - 1;
    const idx = spreads.findIndex((s) => s.includes(pi));
    return idx < 0 ? 0 : idx;
  };
  const currentSpread = () => spreads[spreadIndexAt(cur)] || [cur - 1];
  const prevSpreadLen = () => (spreads[spreadIndexAt(cur) - 1] || [0]).length;

  const goBack = () => {
    // 从图包页点进来的就原路退（保留那边的滚动位置）；直接开链接进来的才推一条
    if (history.state && history.state.from) {
      history.back();
      return;
    }
    history.pushState({}, '', `/p/${id}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  };

  root.innerHTML = `
    <div class="comic" data-mode="${mode}" data-dir="${dir}" data-fit="${fit}">
      <header class="reader-bar comic-bar">
        <div class="cm-left">
          <button class="rb-btn" data-back aria-label="返回图包">‹</button>
          <div class="rb-text">
            <div class="rb-name">${esc(pack.title)}</div>
            <div class="rb-meta"><b data-pos>1</b> / ${total}</div>
          </div>
          <div class="cm-vbar" data-vbar title="进度：点或拖都可跳页"><i data-vfill></i></div>
        </div>
        <span class="spacer"></span>
        <div class="cm-right">
          <div class="cm-seg" data-modes>
            ${MODES.map(
              (m) => `<button data-mode="${m.v}" class="${m.v === mode ? 'on' : ''}">${m.label}</button>`
            ).join('')}
          </div>
          <button class="rb-btn" data-dir-btn title="阅读方向（右 → 左适合日漫）">${dir === 'rtl' ? '←' : '→'}</button>
          <button class="rb-btn" data-fit-btn title="适应方式">${fit === 'width' ? '适宽' : '适高'}</button>
          <button class="rb-btn" data-fs-btn title="全屏（F）">全屏</button>
        </div>
      </header>
      <div class="cm-stage" data-stage></div>
      <div class="cm-hud" data-hud>
        <input type="range" data-slider min="1" max="${total}" value="1" step="1" aria-label="阅读进度" />
        <span class="cm-hud-n"><b data-hud-pos>1</b> / ${total}</span>
      </div>
    </div>`;

  const el = root.querySelector('.comic');
  const stage = root.querySelector('[data-stage]');
  const slider = root.querySelector('[data-slider]');
  const vbar = root.querySelector('[data-vbar]');
  const vfill = root.querySelector('[data-vfill]');
  const posEls = [...root.querySelectorAll('[data-pos], [data-hud-pos]')];

  // ---------------- 进度 ----------------
  let saveTimer = 0;
  const paintPos = () => {
    posEls.forEach((n) => {
      n.textContent = String(cur);
    });
    if (slider.value !== String(cur)) slider.value = String(cur);
    if (vfill) vfill.style.height = `${(cur / total) * 100}%`;
  };
  const setPos = (n, { save = true, scroll = false } = {}) => {
    cur = Math.min(total, Math.max(1, Number(n) || 1));
    snapToSpread();
    paintPos();
    if (save) {
      clearTimeout(saveTimer);
      // 滚动时每帧都写 localStorage 太贵，攒一下
      saveTimer = setTimeout(() => savePos(id, cur), 200);
    }
    if (scroll && mode === 'scroll') window.scrollTo(0, Math.max(0, pageTop(cur - 1) - 8));
  };

  /** 双页模式下把页码对齐到「这一对的第一页」，否则滑块拖到 61 会显示 61 却在看 60-61 */
  function snapToSpread() {
    if (mode !== 'spread') return;
    const sp = spreads[spreadIndexAt(cur)];
    if (sp) cur = sp[0] + 1;
  }

  // ---------------- 侧栏 / 顶栏 ----------------
  /**
   * 页面两侧还有没有空白？有就把控件竖排过去。
   * 用实测图片宽度判断，不看屏幕宽度 —— 双页对开、宽图适宽时页面是满的。
   */
  function syncRail() {
    if (mode === 'scroll') {
      el.classList.remove('is-rail');
      return;
    }
    const imgs = [...stage.querySelectorAll('.cm-shot img')];
    if (!imgs.length) {
      el.classList.remove('is-rail');
      return;
    }
    const w =
      imgs.reduce((a, img) => a + img.getBoundingClientRect().width, 0) + (imgs.length > 1 ? 8 : 0);
    const side = (stage.clientWidth - w) / 2;
    const want = side >= 92;
    if (want !== el.classList.contains('is-rail')) el.classList.toggle('is-rail', want);
  }

  // ---------------- 滚动模式 ----------------
  let tiles = [];
  let offsets = [];
  let io = null;
  const pageTop = (i) => (offsets[i] != null ? offsets[i] : tiles[i] ? tiles[i].offsetTop : 0);

  const measure = () => {
    offsets = tiles.map((t) => t.offsetTop);
  };

  const loadScrollImage = (t) => {
    const img = t.querySelector('img');
    if (!img || img.dataset.on) return;
    img.dataset.on = '1';
    img.addEventListener('load', () => t.classList.add('is-loaded'), { once: true });
    img.src = api.preview(Number(t.dataset.id));
  };

  function renderScroll() {
    stage.classList.remove('is-paged');
    el.classList.remove('is-rail');
    stage.innerHTML = `<div class="cm-strip">${pages
      .map((m, i) => {
        const r = ratioOf(m);
        return `<div class="cm-page" data-i="${i}" data-id="${m.id}"${r ? ` style="aspect-ratio:${r}"` : ''}>
          ${r ? '' : '<div class="cm-ph"></div>'}
          <img alt="${esc(m.fileName || '')}" decoding="async">
          <span class="cm-no">${m.pageNo || i + 1}</span>
        </div>`;
      })
      .join('')}</div>`;
    tiles = [...stage.querySelectorAll('.cm-page')];

    if (io) io.disconnect();
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          loadScrollImage(e.target);
          const i = Number(e.target.dataset.i);
          if (tiles[i - 1]) loadScrollImage(tiles[i - 1]);
          if (tiles[i + 1]) loadScrollImage(tiles[i + 1]);
        }
      },
      { rootMargin: '1200px 0px' }
    );
    tiles.forEach((t) => io.observe(t));

    requestAnimationFrame(() => {
      measure();
      window.scrollTo(0, Math.max(0, pageTop(cur - 1) - 8));
    });
  }

  // ---------------- 单页 / 双页 ----------------
  const warm = new Map();
  const warmPage = (i) => {
    const p = pages[i];
    if (!p || warm.has(p.id)) return;
    const img = new Image();
    img.src = api.preview(p.id);
    warm.set(p.id, img);
    if (warm.size > 10) warm.delete(warm.keys().next().value);
  };

  const ensureSlots = (n) => {
    const wrap = stage.querySelector('.cm-spread');
    while (wrap.children.length > n) wrap.lastElementChild.remove();
    while (wrap.children.length < n) {
      const d = document.createElement('div');
      d.className = 'cm-shot';
      d.innerHTML = '<img alt="" decoding="async"><span class="cm-no"></span>';
      wrap.append(d);
    }
    return [...wrap.children];
  };

  let lastKey = '';
  function paintPaged() {
    const list = mode === 'single' ? [cur - 1] : currentSpread();
    // 换页后回到页首：适宽时上一页滚到一半的位置不该带到下一页
    const key = list.join('-');
    if (key !== lastKey) {
      lastKey = key;
      stage.scrollTop = 0;
    }
    const slots = ensureSlots(list.length);
    slots.forEach((slot, i) => {
      const p = pages[list[i]];
      if (!p) return;
      const img = slot.querySelector('img');
      // 同一页不动 src：换页时浏览器复用已解码的那张，不会白闪
      if (slot.dataset.pid !== String(p.id)) {
        slot.dataset.pid = String(p.id);
        img.onload = () => syncRail();
        img.src = api.preview(p.id);
      }
      slot.querySelector('.cm-no').textContent = String(p.pageNo || list[i] + 1);
      // 细长的条漫页在双页里并排会太小，交给 CSS 单独处理
      slot.classList.toggle('is-narrow', !!(p.width && p.height && p.width / p.height < 0.62));
    });
    // 预取相邻的几页，连按不空屏
    const near =
      mode === 'single'
        ? [cur - 2, cur - 1, cur, cur + 1]
        : [...currentSpread(), ...(spreads[spreadIndexAt(cur) + 1] || []), ...(spreads[spreadIndexAt(cur) - 1] || [])];
    near.forEach((i) => warmPage(i));
    requestAnimationFrame(syncRail);
  }

  function renderPaged() {
    stage.classList.add('is-paged');
    stage.innerHTML = `<div class="cm-spread" data-dir="${dir}"></div>`;
    paintPaged();
  }

  // ---------------- 统一入口 ----------------
  const applyModeClass = () => {
    el.dataset.mode = mode;
    document.body.classList.toggle('cm-locked', mode !== 'scroll');
    root.querySelectorAll('[data-modes] button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  };

  const goto = (n) => {
    if (mode === 'scroll') {
      setPos(n, { scroll: true });
      return;
    }
    setPos(n);
    paintPaged();
  };

  const setMode = (m) => {
    if (m === mode || !MODES.some((x) => x.v === m)) return;
    mode = m;
    savePrefs({ mode, dir, fit });
    applyModeClass();
    snapToSpread();
    if (mode === 'scroll') renderScroll();
    else renderPaged();
    paintPos();
    if (mode === 'scroll') requestAnimationFrame(() => setPos(cur, { scroll: true, save: false }));
  };

  const setDir = (d) => {
    dir = d;
    savePrefs({ mode, dir, fit });
    el.dataset.dir = dir;
    root.querySelector('[data-dir-btn]').textContent = dir === 'rtl' ? '←' : '→';
    const wrap = stage.querySelector('.cm-spread');
    if (wrap) wrap.dataset.dir = dir;
  };

  const setFit = (f) => {
    fit = f;
    savePrefs({ mode, dir, fit });
    el.dataset.fit = fit;
    root.querySelector('[data-fit-btn]').textContent = fit === 'width' ? '适宽' : '适高';
    requestAnimationFrame(syncRail);
  };

  // ---------------- 事件 ----------------
  root.querySelector('[data-back]').addEventListener('click', goBack);

  root.querySelector('[data-modes]').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  root.querySelector('[data-dir-btn]').addEventListener('click', () => setDir(dir === 'rtl' ? 'ltr' : 'rtl'));
  root.querySelector('[data-fit-btn]').addEventListener('click', () => setFit(fit === 'width' ? 'height' : 'width'));

  const fsBtn = root.querySelector('[data-fs-btn]');
  const onFsChange = () => {
    const on = !!document.fullscreenElement;
    fsBtn.textContent = on ? '退出' : '全屏';
    el.classList.toggle('is-fs', on);
    if (on) wake();
    // 视口高度变了，滚动模式的页顶位置要重新量；单双页交给 CSS 自动适配
    requestAnimationFrame(() => {
      if (mode === 'scroll') {
        measure();
        window.scrollTo(0, Math.max(0, pageTop(cur - 1) - 8));
      } else {
        syncRail();
      }
    });
  };
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    // 整页进全屏：.comic 自己进全屏后文档不再滚动，滚动模式会滚不动
    else (document.documentElement.requestFullscreen?.() || Promise.reject()).catch(() =>
      toast('这个浏览器不支持全屏')
    );
  };
  fsBtn.addEventListener('click', toggleFs);
  document.addEventListener('fullscreenchange', onFsChange);

  slider.addEventListener('input', () => {
    const n = Number(slider.value);
    if (mode === 'scroll') window.scrollTo(0, Math.max(0, pageTop(n - 1) - 8));
    setPos(n);
    if (mode !== 'scroll') paintPaged();
  });

  /* 侧栏上的竖向进度条：点一下或按住拖都能跳页（原生 range 竖排在部分版本里不生效，
     这里自己画一个 4px 的轨道，行为可控） */
  let dragging = false;
  const seekFromEvent = (e) => {
    const r = vbar.getBoundingClientRect();
    if (!r.height) return;
    const y = Math.min(r.bottom, Math.max(r.top, e.clientY));
    const ratio = 1 - (y - r.top) / r.height;
    goto(Math.round(ratio * (total - 1)) + 1);
  };
  const onVbarDown = (e) => {
    dragging = true;
    seekFromEvent(e);
    e.preventDefault();
  };
  const onVbarMove = (e) => {
    if (dragging) seekFromEvent(e);
  };
  const onVbarUp = () => {
    dragging = false;
  };
  vbar.addEventListener('pointerdown', onVbarDown);
  window.addEventListener('pointermove', onVbarMove);
  window.addEventListener('pointerup', onVbarUp);

  /** 点击翻页：单页 / 双页里点右（右→左时点左）翻下一页，另一侧上一页，中间不动 */
  stage.addEventListener('click', (e) => {
    if (mode === 'scroll') return;
    if (e.target.closest('a, button')) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const forward = dir === 'rtl' ? x < 0.35 : x > 0.65;
    const backward = dir === 'rtl' ? x > 0.65 : x < 0.35;
    if (forward) goto(cur + (mode === 'spread' ? currentSpread().length : 1));
    else if (backward) goto(cur - (mode === 'spread' ? prevSpreadLen() : 1));
  });

  /* 滚轮 / 触控板：单页、双页里按页翻。
     一屏一页的时候「滚了没反应」最容易被当成坏了；适宽时页面比舞台高，
     先把这一页滚完，滚到边缘再翻下一页（触控板惯性会被 420ms 的冷却挡住）。 */
  let wheelAcc = 0;
  let wheelAt = 0;
  const onWheel = (e) => {
    if (mode === 'scroll' || e.ctrlKey) return;
    const main = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!main) return;
    // 这一页还有没滚完的部分：让浏览器先滚它
    if (stage.scrollHeight > stage.clientHeight + 2) {
      const atTop = stage.scrollTop <= 1;
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      if ((main > 0 && !atBottom) || (main < 0 && !atTop)) return;
    }
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 420) {
      wheelAcc = 0;
      return;
    }
    // deltaMode: 0 像素 / 1 行 / 2 页
    wheelAcc += main * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (Math.abs(wheelAcc) < 60) return;
    const forward = wheelAcc > 0;
    wheelAcc = 0;
    wheelAt = now;
    if (mode === 'spread') goto(cur + (forward ? currentSpread().length : -prevSpreadLen()));
    else goto(cur + (forward ? 1 : -1));
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  // 触屏左右滑
  let touchX = 0;
  let touchY = 0;
  const onTouchStart = (e) => {
    if (mode === 'scroll' || !e.touches[0]) return;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  };
  const onTouchEnd = (e) => {
    if (mode === 'scroll' || !touchX) return;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!t) return;
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    touchX = 0;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
    const swipeLeft = dx < 0;
    const forward = dir === 'rtl' ? !swipeLeft : swipeLeft;
    goto(cur + (forward ? 1 : -1));
  };
  stage.addEventListener('touchstart', onTouchStart, { passive: true });
  stage.addEventListener('touchend', onTouchEnd, { passive: true });

  // 滚动模式的进度
  let scrollTimer = 0;
  const onScroll = () => {
    if (mode !== 'scroll') return;
    const probe = window.scrollY + window.innerHeight * 0.34;
    let n = 1;
    for (let i = 0; i < tiles.length; i += 1) {
      if (pageTop(i) <= probe) n = i + 1;
      else break;
    }
    if (n !== cur) setPos(n);
  };
  const onScrollThrottled = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(onScroll, 90);
  };
  window.addEventListener('scroll', onScrollThrottled, { passive: true });

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (mode === 'scroll') measure();
      else syncRail();
    }, 200);
  };
  window.addEventListener('resize', onResize);

  /** 全屏时鼠标静止 2.4s 就把控件淡掉，动一下再回来 */
  let idleTimer = 0;
  const wake = () => {
    el.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (!document.fullscreenElement) return;
    idleTimer = setTimeout(() => el.classList.add('is-idle'), 2400);
  };
  window.addEventListener('mousemove', wake, { passive: true });

  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
    if (escDepth() > 0) return;
    const k = e.key;

    if (k === 'Escape') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen?.();
      else goBack();
      return;
    }
    if (k === 'f' || k === 'F') {
      e.preventDefault();
      toggleFs();
      return;
    }
    if (k === '1' || k === '2' || k === '3') {
      e.preventDefault();
      setMode(MODES[Number(k) - 1].v);
      return;
    }
    if (k === 'Home') {
      e.preventDefault();
      goto(1);
      return;
    }
    if (k === 'End') {
      e.preventDefault();
      goto(total);
      return;
    }

    if (mode === 'scroll') {
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') {
        e.preventDefault();
        goto(cur + 1);
      } else if (k === 'ArrowLeft' || k === 'PageUp') {
        e.preventDefault();
        goto(cur - 1);
      }
      return;
    }

    const step = mode === 'spread' ? currentSpread().length : 1;
    if (k === nextKey() || k === 'PageDown' || k === ' ') {
      e.preventDefault();
      goto(cur + step);
    } else if (k === prevKey() || k === 'PageUp') {
      e.preventDefault();
      goto(cur - (mode === 'spread' ? prevSpreadLen() : 1));
    }
  };
  document.addEventListener('keydown', onKey);
  wake();

  // ---------------- 起手 ----------------
  applyModeClass();
  const start = Number(new URLSearchParams(location.search).get('p')) || loadPos(id) || 1;
  cur = Math.min(total, Math.max(1, start));
  paintPos();
  if (mode === 'scroll') {
    renderScroll();
  } else {
    renderPaged();
    // 双页模式：把「第 p 页」对齐到它所在的那一对的开头
    if (mode === 'spread') {
      cur = currentSpread()[0] + 1;
      paintPos();
      paintPaged();
    }
  }
  document.title = `${pack.title} · 阅读`;

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    window.removeEventListener('scroll', onScrollThrottled);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('mousemove', wake);
    stage.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointermove', onVbarMove);
    window.removeEventListener('pointerup', onVbarUp);
    clearTimeout(scrollTimer);
    clearTimeout(resizeTimer);
    clearTimeout(idleTimer);
    clearTimeout(saveTimer);
    if (io) io.disconnect();
    document.body.classList.remove('cm-locked');
    if (document.fullscreenElement) document.exitFullscreen?.();
    savePos(id, cur);
  };
}
