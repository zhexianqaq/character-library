import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, toast, debounce, deleteSummary } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { createDropdown } from '../components/dropdown.js';
import { confirmDialog } from '../components/modal.js';
import { openContextMenu } from '../components/context-menu.js';
import { mediaMenu } from '../components/media-actions.js';
import { bindDropUpload } from '../components/dropzone.js';
import { queue } from '../upload-queue.js';
import { applyPickClick } from '../selection.js';
import { pushEsc, escDepth } from '../esc.js';

const PAGE_SIZE = 120;

/**
 * 上次分发用的库（模块级：切库、重新渲染都还在）。
 *
 * 连续往角色库分发时，每次打开都落回「人物库」很烦 —— shelves[0] 永远是人物库。
 * 只记库不记条目：条目默认还是第一个，免得不小心又分给上一个角色。
 */
let lastDistShelf = 0;

/**
 * 全部库（kind=inbox）：一个「收件箱 + 总览」两用的库。
 *
 *   未分发 —— 媒体挂在库的隐藏容器条目下面，文件在 <库名>/未分类/图片|视频
 *   已分发 —— 全库**其它所有**图片/视频的只读聚合，不复制、不移动，点开走 /i/:id
 *
 * 分发不是新动作：选中后调 POST /api/packs/:id/media，跨条目移动本来就会
 * 搬文件 + 写 journal + 失败回滚，这里只是给它一个顺手的入口。
 */
export async function InboxView(root, shelfId, opts = {}) {
  /* 嵌入首页时不自带顶栏：顶栏和库切换条由 LibraryView 提供 */
  const embedded = !!opts.embedded;
  let section = 'undistributed';
  let kind = '';
  let q = '';
  let page = 1;
  let total = 0;
  let counts = { undistributed: { image: 0, video: 0 }, distributed: { image: 0, video: 0 } };
  let items = [];
  let shelfInfo = { id: shelfId, name: '全部库' };
  let containerId = 0;
  let selecting = false;
  const picked = new Set();
  let anchorId = null;

  const first = await api.inboxShelf(shelfId, { section, kind });
  shelfInfo = first.shelf;
  containerId = first.containerId;
  total = first.total;
  counts = first.counts;
  items = first.items;

  root.innerHTML =
    (embedded
      ? ''
      : topbarHtml({
          back: true,
          title: shelfInfo.name,
          sub: '收件箱',
        })) +
    `<main class="page">
       <div class="shelf-head">
         <div class="sh-main">
           <h1 class="sh-title">${esc(shelfInfo.name)}</h1>
           <div class="sh-meta" data-meta></div>
         </div>
         <span class="spacer"></span>
         <button class="tb-btn" data-select-toggle>选取</button>
         <button class="tb-btn primary" data-upload>↑ 收素材</button>
       </div>
       <section class="lib-stats" data-stats>
         <div class="ls-head"><b>库总览</b><span data-totals>加载中…</span></div>
         <div class="ls-grid" data-ls-grid></div>
       </section>
       <div class="toolbar">
         <div class="segmented" data-sec>
           <button class="on" data-s="undistributed">未分发<i>0</i></button>
           <button data-s="distributed">已分发<i>0</i></button>
         </div>
         <div class="filter-bar">
           <div class="segmented" data-kind>
             <button class="on" data-k="">全部</button>
             <button data-k="image">图片</button>
             <button data-k="video">视频</button>
           </div>
           <label class="search filter-search">
             <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
               <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
             </svg>
             <input type="search" placeholder="搜索文件名 / 条目 / 图包" autocomplete="off" spellcheck="false" data-q />
           </label>
         </div>
         <span class="spacer"></span>
         <span class="count" data-count></span>
       </div>
       <div data-body></div>
       <div class="sel-bar" data-selbar hidden></div>
     </main>`;

  if (!embedded) bindTopbar(root);
  document.title = `${shelfInfo.name} · 全部库`;

  const bodyEl = root.querySelector('[data-body]');

  // ---------- 头部与角标 ----------
  function paintMeta() {
    const u = counts.undistributed;
    const d = counts.distributed;
    const st = u.image + u.video;
    const di = d.image + d.video;
    root.querySelector('[data-meta]').textContent = [
      `待分发 ${fmtNum(st)}`,
      `已分发 ${fmtNum(di)}`,
      st ? '选几项 →「分发到…」就会把文件搬进角色目录' : '拖入手机里的照片 / 视频就能开始',
    ].join(' · ');
  }

  /** 每个库的条目叫法（卡片副标题、悬停提示用） */
  const UNIT = {
    people: '人物',
    work: '角色',
    novel: '小说',
    resource: '作品',
    emoji: '图包',
    inbox: '待分发',
  };

  /**
   * 库总览：一行加起来的总数 + 每个库一张小卡（媒体数、条目数、占用、占比条）。
   * 点卡片直接切到那个库 —— 首页标签条也能切，但这里能顺手看出谁的占用最大。
   *
   * 首页 embed 进来时 LibraryView 已经取过 overview，直接复用（opts.overview），
   * 不要再打一次那个每库 5 个子查询的接口。
   */
  async function paintStats() {
    const grid = root.querySelector('[data-ls-grid]');
    const totalEl = root.querySelector('[data-totals]');
    if (!grid || !totalEl) return;
    let ov = opts.overview;
    if (!ov) {
      try {
        ov = await api.overview();
      } catch {
        totalEl.textContent = '统计加载失败';
        return;
      }
    }
    if (!root.isConnected || !grid.isConnected) return;

    const shelves = ov.shelves || [];
    const t = ov.totals || { characters: 0, media: 0, bytes: 0 };
    totalEl.textContent = [
      `${shelves.length} 个库`,
      `${fmtNum(t.characters)} 个条目`,
      `${fmtNum(t.media)} 个媒体`,
      fmtBytes(t.bytes || 0),
    ].join(' · ');

    grid.innerHTML = shelves
      .map((s) => {
        const pct = t.bytes ? Math.round(((s.bytes || 0) / t.bytes) * 1000) / 10 : 0;
        // 主数字是「多少个」：人物 / 角色 / 小说 / 作品 / 图包；全部库没有条目，用待分发素材数
        const cnt = s.kind === 'emoji' ? s.packCount : s.kind === 'inbox' ? s.mediaCount : s.characterCount;
        const sub =
          s.kind === 'inbox' ? '待分发' : `${UNIT[s.kind] || '条目'} · ${fmtNum(s.mediaCount)} 个媒体`;
        return `<button class="ls-card${s.id === shelfInfo.id ? ' is-on' : ''}" data-goto="${s.id}"
            title="${esc(s.name)} · ${fmtNum(cnt)} ${UNIT[s.kind] || '个条目'} · ${fmtNum(s.mediaCount)} 个媒体 · ${fmtBytes(
              s.bytes || 0
            )}（占总占用 ${pct}%）">
          <span class="ls-name">${esc(s.name)}</span>
          <b class="ls-n">${fmtNum(cnt)}</b>
          <span class="ls-sub">${sub}</span>
          <span class="ls-bar"><i style="width:${Math.min(100, pct)}%"></i></span>
          <span class="ls-bytes">${fmtBytes(s.bytes || 0)} · ${pct}%</span>
        </button>`;
      })
      .join('');

    grid.onclick = (e) => {
      const btn = e.target.closest('[data-goto]');
      if (!btn) return;
      const id = Number(btn.dataset.goto);
      if (!id || id === shelfInfo.id) return; // 点当前库不跳
      history.pushState({}, '', `/s/${id}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    };
  }

  function paintTabs() {
    root.querySelectorAll('[data-sec] button').forEach((b) => {
      const c = counts[b.dataset.s] || { image: 0, video: 0 };
      const i = b.querySelector('i');
      if (i) i.textContent = fmtNum(c.image + c.video);
      b.classList.toggle('on', b.dataset.s === section);
    });
    root.querySelectorAll('[data-kind] button').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
    const el = root.querySelector('[data-count]');
    if (el) el.textContent = total ? `${fmtNum(items.length)} / ${fmtNum(total)} 个` : '';
  }

  // ---------- 网格 ----------
  function emptyHtml() {
    if (q) return '<div class="empty"><b>没有匹配的素材</b>换个关键词，或把搜索框清空</div>';
    if (kind) return `<div class="empty"><b>这里还没有${kind === 'image' ? '图片' : '视频'}</b>换成「全部」看看</div>`;
    return section === 'undistributed'
      ? '<div class="empty"><b>没有待分发的素材</b>把手机里存的一堆图片视频拖进这个页面，或点右上角「收素材」</div>'
      : '<div class="empty"><b>还没有分发出去的素材</b>分发后会在这里留一个入口，文件仍在原来的角色目录里</div>';
  }

  /** 当前网格里已经画了多少张 —— 「加载更多」只补这之后的，不重画前面的 */
  let renderedCount = 0;

  function onTileOpen(i, ev) {
    if (selecting) {
      pickByClick(items[i].id, ev);
      return;
    }
    // Ctrl / Shift + 点击：不用先点「选取」，直接进多选并选中这一张
    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
      enterSelect(items[i].id, ev);
      return;
    }
    gotoMedia(items[i].id);
  }

  function tileOpts() {
    return {
      selectable: selecting,
      isPicked: (it) => picked.has(it.id),
      spanWide: true,
      onContext: (e, item) => {
        e.preventDefault();
        e.stopPropagation();
        openMediaMenu(e, item);
      },
    };
  }

  /** 「加载更多」：滚到接近底部就自动拉下一批，按钮留着当兜底 / 重试 */
  let loadingMore = false;
  let moreFailed = false;
  let moreObserver = null;

  function syncMore() {
    const box = bodyEl.querySelector('.inbox-more');
    if (!box) return;
    const done = items.length >= total;
    box.hidden = done;
    const btn = box.querySelector('[data-more]');
    if (btn) {
      btn.disabled = loadingMore;
      btn.textContent = loadingMore ? '加载中…' : '加载更多';
    }
    if (done && moreObserver) {
      moreObserver.disconnect();
      moreObserver = null;
    }
  }

  function buildGridShell() {
    bodyEl.innerHTML =
      '<div class="masonry" data-masonry></div>' +
      '<div class="inbox-more"><button class="tb-btn" data-more>加载更多</button></div>';
    bodyEl.querySelector('[data-more]').addEventListener('click', () => {
      moreFailed = false; // 手动点就是重试
      loadMore();
    });
    observeMore();
  }

  /**
   * 监听底部那一块：进入视口就自动加载。
   * 提前 600px 触发，滚到底时下一批通常已经画好了，不会看到「空一段再蹦出来」。
   */
  function observeMore() {
    if (moreObserver) moreObserver.disconnect();
    const box = bodyEl.querySelector('.inbox-more');
    if (!box || typeof IntersectionObserver === 'undefined') return;
    moreObserver = new IntersectionObserver(
      (entries) => {
        if (moreFailed) return;
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '600px 0px' }
    );
    moreObserver.observe(box);
  }

  async function loadMore() {
    if (loadingMore || items.length >= total) return;
    loadingMore = true;
    syncMore();
    page += 1;
    try {
      await load({ append: true });
    } catch (err) {
      page -= 1;
      // 失败就别再自动试了，按钮还在，用户点一下算重试
      moreFailed = true;
      toast(err.message || '加载失败');
    } finally {
      loadingMore = false;
      syncMore();
      if (!moreFailed) fillViewport();
    }
  }

  /**
   * 一批没铺满视口时接着拉。
   * IntersectionObserver 只在「相交状态变化」时回调 —— 内容不满一屏，
   * 哨兵一直停在视野里，不主动检查的话就只会加载一批然后卡住。
   */
  function fillViewport() {
    const box = bodyEl.querySelector('.inbox-more');
    if (!box || box.hidden) return;
    if (box.getBoundingClientRect().top < window.innerHeight + 600) {
      // 走 microtask，别在 finally 里同步递归
      queueMicrotask(() => loadMore());
    }
  }

  function renderGrid({ append = false } = {}) {
    if (!items.length) {
      bodyEl.innerHTML = emptyHtml();
      renderedCount = 0;
      return;
    }
    const holder = bodyEl.querySelector('[data-masonry]');
    // 只有「追加到同一个网格」才增量；筛选 / 选取态切换 / 删除后重建都走全量
    const canAppend = append && holder && renderedCount > 0 && renderedCount <= items.length;
    if (!canAppend) {
      buildGridShell();
      renderedCount = 0;
      moreFailed = false; // 换了筛选 / 重新加载：上一轮的失败不算数
    }
    const target = bodyEl.querySelector('[data-masonry]');
    const from = renderedCount;
    renderedCount = items.length;
    requestAnimationFrame(() => {
      renderMasonry(target, items, onTileOpen, { ...tileOpts(), appendFrom: from });
    });
    syncMore();
  }

  async function load({ append = false } = {}) {
    const r = await api.inboxShelf(shelfId, { section, kind, q, page, pageSize: PAGE_SIZE });
    shelfInfo = r.shelf;
    containerId = r.containerId;
    total = r.total;
    counts = r.counts;
    items = append ? items.concat(r.items) : r.items;
    paintMeta();
    paintTabs();
    renderGrid({ append });
  }

  function gotoMedia(id) {
    history.pushState({ from: location.pathname + location.search }, '', `/i/${id}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  /** 重新拉一遍已经翻过的所有页：改名 / 改标签 / 删除之后不用退回第一页 */
  async function reloadLoaded() {
    const pages = Math.max(1, page);
    const chunks = [];
    let info = null;
    for (let p = 1; p <= pages; p += 1) {
      const r = await api.inboxShelf(shelfId, { section, kind, q, page: p, pageSize: PAGE_SIZE });
      info = r;
      chunks.push(...r.items);
      if (r.items.length < PAGE_SIZE) break;
    }
    if (!info) return;
    shelfInfo = info.shelf;
    containerId = info.containerId;
    total = info.total;
    counts = info.counts;
    items = chunks;
    paintMeta();
    paintTabs();
    renderGrid();
  }

  /**
   * 瓦片右键：和角色库 / 图包页共用同一套媒体菜单。
   * 全部库有三项不该出现 —— 素材没有图包（设不了图包封面、也没处可移动）、
   * 归属条目是隐藏容器（设不了「条目封面」）、本来就在全部库里（不用再移出）。
   *
   * 如果右键的是「已选中的那几张之一」，菜单换成批量动作 ——
   * 否则选了 50 张、右键点删除，只删一张会很意外。
   */
  function openMediaMenu(e, item) {
    if (selecting && picked.size > 1 && picked.has(item.id)) {
      openContextMenu(e, [
        { label: '打开这一张', onClick: () => gotoMedia(item.id) },
        { separator: true },
        { label: `分发选中的 ${picked.size} 个…`, onClick: () => onSelAction('move') },
        { label: `删除选中的 ${picked.size} 个`, danger: true, onClick: () => onSelAction('del') },
        { separator: true },
        { label: '退出选取', onClick: () => exitSelect() },
      ]);
      return;
    }
    mediaMenu(e, item, {
      onOpen: () => gotoMedia(item.id),
      onChange: reloadLoaded,
      shelfKind: 'inbox',
      allowMove: false,
      extra: [
        {
          label: '分发到…',
          hint: '移进角色图包',
          onClick: () => {
            // 单张分发：借用多选那条路，先把选区缩成这一张
            picked.clear();
            picked.add(item.id);
            anchorId = item.id;
            openDistribute();
          },
        },
        { separator: true },
      ],
    });
  }

  // ---------- 多选 ----------
  function pickByClick(id, ev) {
    const ordered = items.map((m) => m.id);
    const r = applyPickClick({ picked, ordered, id, ev, anchorId });
    anchorId = r.anchorId;
    root.querySelectorAll('.tile[data-id]').forEach((el) => {
      el.classList.toggle('is-sel', picked.has(Number(el.dataset.id)));
    });
    syncSelCount();
  }

  function syncSelCount() {
    const n = root.querySelector('[data-selbar] .sel-n b');
    if (n) n.textContent = String(picked.size);
    const btn = root.querySelector('[data-sel="move"]');
    if (btn) btn.disabled = !picked.size;
  }

  function selBar() {
    return root.querySelector('[data-selbar]');
  }

  function enterSelect(firstId = null, ev = null) {
    selecting = true;
    picked.clear();
    anchorId = null;
    root.classList.add('is-selecting');
    const t = root.querySelector('[data-select-toggle]');
    if (t) t.textContent = '完成';
    renderGrid();
    const bar = selBar();
    if (bar) {
      bar.hidden = false;
      bar.innerHTML = `
        <span class="sel-n">已选 <b>0</b> 个素材</span>
        <button data-sel="all">全选</button>
        <button data-sel="move" class="primary" disabled>分发到…</button>
        <button data-sel="del" class="danger">删除</button>
        <button data-sel="exit">完成</button>`;
      bar.querySelectorAll('button[data-sel]').forEach((b) =>
        b.addEventListener('click', () => onSelAction(b.dataset.sel))
      );
    }
    // Ctrl+点击进来时顺手把这一张选上：renderGrid 的瓦片是下一帧画的，等一帧再勾
    if (firstId) requestAnimationFrame(() => pickByClick(firstId, ev || {}));
  }

  function exitSelect() {
    selecting = false;
    picked.clear();
    anchorId = null;
    root.classList.remove('is-selecting');
    const t = root.querySelector('[data-select-toggle]');
    if (t) t.textContent = '选取';
    const bar = selBar();
    if (bar) {
      bar.hidden = true;
      bar.innerHTML = '';
    }
    renderGrid();
  }

  function onSelAction(action) {
    if (action === 'exit') return exitSelect();
    if (action === 'all') {
      const allOn = items.length > 0 && items.every((m) => picked.has(m.id));
      if (allOn) picked.clear();
      else items.forEach((m) => picked.add(m.id));
      anchorId = items.length ? items[items.length - 1].id : null;
      root.querySelectorAll('.tile[data-id]').forEach((el) => {
        el.classList.toggle('is-sel', picked.has(Number(el.dataset.id)));
      });
      return syncSelCount();
    }
    if (!picked.size) return;
    if (action === 'del') return bulkDelete();
    if (action === 'move') return openDistribute();
  }

  async function bulkDelete() {
    const ids = [...picked];
    const ok = await confirmDialog(
      `删除 ${ids.length} 个素材？`,
      '磁盘上的原文件也会一起删除，不可恢复。'
    );
    if (!ok) return;
    try {
      const res = await api.bulkMedia(ids, 'delete');
      toast(deleteSummary(res, '素材'));
      exitSelect();
      await load();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  // ---------- 分发 ----------
  async function openDistribute() {
    const ids = [...picked];
    if (!ids.length) return;
    let shelves = [];
    try {
      shelves = (await api.shelves()).filter((s) => s.kind === 'people' || s.kind === 'work');
    } catch {
      shelves = [];
    }
    if (!shelves.length) {
      toast('还没有人物库或角色库，先去首页建一个');
      return;
    }

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal tag-modal inbox-move" role="dialog" aria-modal="true">
        <h3>分发 ${ids.length} 个素材</h3>
        <p class="tag-note">${section === 'distributed' ? '选中的素材会从原条目移动到目标角色的图包目录' : `文件会从「${esc(shelfInfo.name)}/未分类」移动到目标角色的图包目录`}，不留副本；目标已有同一份文件时跳过。</p>
        <div class="dist-hint" data-slot-tags hidden></div>
        <label class="field"><span>库</span><div data-slot-shelf></div></label>
        <label class="field"><span>条目</span><div data-slot-char></div></label>
        <label class="field"><span>图包</span><div data-slot-pack></div></label>
        <div class="modal-actions">
          <button class="tb-btn" data-cancel>取消</button>
          <button class="tb-btn primary" data-ok>移动并分发</button>
        </div>
      </div>`;
    let offEsc = null;
    const close = () => {
      mask.remove();
      if (offEsc) {
        offEsc();
        offEsc = null;
      }
    };
    offEsc = pushEsc(close, () => mask.isConnected, 'inbox-move');
    document.body.appendChild(mask);
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) close();
    });
    mask.querySelector('[data-cancel]').addEventListener('click', close);

    let charDD = null;
    let packDD = null;

    async function loadPacks(charId) {
      const slot = mask.querySelector('[data-slot-pack]');
      let list = [];
      try {
        list = charId ? (await api.packs(charId)).items || [] : [];
      } catch {
        list = [];
      }
      const opts = list.map((p) => ({
        value: String(p.id),
        label: `${p.title}${p.mediaCount ? `（${fmtNum(p.mediaCount)}）` : ''}`,
      }));
      opts.push({ value: '__new__', label: '＋ 新建图包（按今天）' });
      if (!packDD) {
        packDD = createDropdown({ options: opts, value: opts[0].value, allowEmpty: false });
        slot.appendChild(packDD.el);
      } else {
        packDD.setOptions(opts);
        packDD.setValue(opts[0].value);
      }
    }

    async function loadChars(shelf, preferId = 0) {
      const slot = mask.querySelector('[data-slot-char]');
      let list = [];
      try {
        // 按素材数排：默认落在最常打理的条目上，它的图包列表也更有用
        list = (await api.shelfCharacters(shelf, { sort: 'media' })).items || [];
      } catch {
        list = [];
      }
      const opts = list.map((c) => ({
        value: String(c.id),
        label: `${c.name}${c.mediaCount ? `（${fmtNum(c.mediaCount)}）` : ''}`,
      }));
      if (!opts.length) {
        if (charDD) charDD.setOptions([{ value: '', label: '这个库还没有条目' }]);
        else {
          charDD = createDropdown({ options: [{ value: '', label: '这个库还没有条目' }], allowEmpty: true });
          slot.appendChild(charDD.el);
        }
        await loadPacks(0);
        return;
      }
      // 目标条目优先（按标签匹配点过来的），否则落回第一个
      const def = preferId && opts.some((o) => Number(o.value) === Number(preferId)) ? String(preferId) : opts[0].value;
      if (!charDD) {
        charDD = createDropdown({
          options: opts,
          value: def,
          allowEmpty: false,
          // 上千个条目滚不动，直接打字筛
          searchable: true,
          onChange: (v) => loadPacks(Number(v)),
        });
        slot.appendChild(charDD.el);
      } else {
        charDD.setOptions(opts);
        charDD.setValue(def);
      }
      await loadPacks(Number(def));
    }

    // 上次选过哪个库就用哪个，没有就第一个
    const defShelf = shelves.find((s) => s.id === lastDistShelf) || shelves[0];
    const shelfDD = createDropdown({
      options: shelves.map((s) => ({ value: String(s.id), label: s.name })),
      value: String(defShelf.id),
      allowEmpty: false,
      onChange: (v) => {
        lastDistShelf = Number(v);
        loadChars(Number(v));
      },
    });
    mask.querySelector('[data-slot-shelf]').appendChild(shelfDD.el);
    await loadChars(Number(defShelf.id));
    paintTagHints();

    /**
     * 「按标签分发」：选中素材身上如果有标签，并且某个条目正好叫这个名字，
     * 就在顶部列成一行 —— 点一下直接把库和条目拨过去，不用在几千个条目里翻。
     * 只做定位，不自动执行，图包还是让用户确认。
     */
    async function paintTagHints() {
      const slot = mask.querySelector('[data-slot-tags]');
      if (!slot) return;
      const pickedSet = new Set(ids);
      const tags = new Set();
      for (const it of items) {
        if (!pickedSet.has(it.id)) continue;
        for (const t of it.ownTags || []) if (t) tags.add(t);
      }
      if (!tags.size) return;

      // 标签名 → 同名条目。条目按库拉一遍（每个库一次请求），比逐个标签查快
      const byName = new Map();
      for (const s of shelves) {
        try {
          const list = (await api.shelfCharacters(s.id, { sort: 'name' })).items || [];
          for (const c of list) if (!byName.has(c.name)) byName.set(c.name, { id: c.id, shelfId: s.id, shelfName: s.name });
        } catch {
          /* 某个库拿不到就跳过，不影响手动选 */
        }
      }
      const hits = [...tags].map((t) => ({ tag: t, hit: byName.get(t) })).filter((x) => x.hit);
      if (!hits.length || !mask.isConnected) return;

      slot.hidden = false;
      slot.innerHTML =
        '<span>按标签匹配</span>' +
        hits
          .map(
            (x) =>
              `<button type="button" class="dist-tag" data-shelf="${x.hit.shelfId}" data-char="${x.hit.id}" title="定位到「${esc(
                x.hit.shelfName
              )} / ${esc(x.tag)}」">${esc(x.tag)} <i>→ ${esc(x.hit.shelfName)}</i></button>`
          )
          .join('');

      slot.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-shelf]');
        if (!b) return;
        const sid = Number(b.dataset.shelf);
        const cid = Number(b.dataset.char);
        shelfDD.setValue(String(sid));
        lastDistShelf = sid; // setValue 不触发 onChange，这里手动记一下
        await loadChars(sid, cid);
        toast('已定位到该条目，确认图包后点「移动并分发」');
      });
    }

    const okBtn = mask.querySelector('[data-ok]');
    okBtn.addEventListener('click', async () => {
      const charId = Number(charDD && charDD.getValue());
      if (!charId) return toast('先选一个条目');
      let packId = packDD && packDD.getValue();
      okBtn.disabled = true;
      okBtn.textContent = '搬移中…';
      try {
        if (!packId || packId === '__new__') {
          const created = await api.createPack(charId, { title: '', month: '' });
          packId = created.id;
        }
        const r = await api.addMediaToPack(Number(packId), ids);
        // 记下这次用的库：下一张分发时直接停在这里
        lastDistShelf = Number(shelfDD.getValue()) || lastDistShelf;
        const bad = r.skipped || [];
        toast(
          bad.length
            ? `已分发 ${r.moved} 个，${bad.length} 个没搬（${bad[0].reason}）`
            : `已分发 ${r.moved} 个素材`
        );
        close();
        exitSelect();
        await load();
      } catch (err) {
        toast(err.message || '分发失败');
        okBtn.disabled = false;
        okBtn.textContent = '移动并分发';
      }
    });
  }

  // ---------- 上传 ----------
  function target() {
    // 容器条目 = <库名>/未分类，upload 见到 char.is_container 就不再按日期建图包
    return { charId: containerId, charName: shelfInfo.name, packId: null, packTitle: '', category: null };
  }

  function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*';
    input.style.display = 'none';
    root.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;
      const n = queue.enqueue(files, target());
      toast(n ? `已加入上传队列 ${n} 个文件 · 点右下角看进度` : '这些文件已经在队列里了');
    });
    input.click();
  }

  queue.onIdle = async () => {
    if (!root.isConnected) return;
    try {
      await load();
    } catch {
      /* 页面可能已经切走了 */
    }
  };

  // ---------- 绑定 ----------
  root.querySelector('[data-upload]').addEventListener('click', pickFiles);
  root.querySelector('[data-select-toggle]').addEventListener('click', () => {
    if (selecting) exitSelect();
    else enterSelect();
  });

  root.querySelector('[data-sec]').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b || b.dataset.s === section) return;
    section = b.dataset.s;
    page = 1;
    if (selecting) exitSelect();
    load();
  });

  root.querySelector('[data-kind]').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || b.dataset.k === kind) return;
    kind = b.dataset.k;
    page = 1;
    if (selecting) exitSelect();
    load();
  });

  const searchInput = root.querySelector('[data-q]');
  searchInput.addEventListener(
    'input',
    debounce(() => {
      q = searchInput.value.trim();
      page = 1;
      if (selecting) exitSelect();
      load();
    }, 260)
  );

  bindDropUpload(root.querySelector('.page'), target);

  // 空白处右键：选取 / 全选 / 收素材 / 刷新（瓦片自己的 contextmenu 已经 stopPropagation）
  bodyEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return;
    e.preventDefault();
    openContextMenu(e, [
      { label: selecting ? '退出选取' : '选取素材', hint: '也可以按 Ctrl+A', onClick: () => (selecting ? exitSelect() : enterSelect()) },
      selecting ? { label: '全选已加载的素材', onClick: () => onSelAction('all') } : null,
      { label: '收素材', hint: '也可以直接拖进来', onClick: () => root.querySelector('[data-upload]').click() },
      { separator: true },
      { label: '刷新', onClick: () => reloadLoaded() },
    ]);
  });

  /** Esc 退出选取、Ctrl+A 全选、Delete 删除（弹窗 / 下拉开着时归它们管） */
  const onKey = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (escDepth() > 0) return;
    if (!selecting) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSelect();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      onSelAction('all');
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!picked.size) return;
      e.preventDefault();
      onSelAction('del');
    }
  };
  document.addEventListener('keydown', onKey);

  paintMeta();
  paintTabs();
  // 放在最后调：opts.overview 有值时这里是同步执行，会用到上面定义的 UNIT，
  // 提前调（const 还没初始化）会踩 TDZ
  paintStats();
  renderGrid();

  return () => {
    document.removeEventListener('keydown', onKey);
    if (moreObserver) {
      moreObserver.disconnect();
      moreObserver = null;
    }
  };
}
