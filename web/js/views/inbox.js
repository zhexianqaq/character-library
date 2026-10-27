import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, toast, fadeIn, debounce, deleteSummary } from '../util.js';
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

  paintStats();

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
   */
  async function paintStats() {
    const grid = root.querySelector('[data-ls-grid]');
    const totalEl = root.querySelector('[data-totals]');
    if (!grid || !totalEl) return;
    let ov;
    try {
      ov = await api.overview();
    } catch {
      totalEl.textContent = '统计加载失败';
      return;
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

  function renderGrid() {
    if (!items.length) {
      bodyEl.innerHTML = emptyHtml();
      return;
    }
    bodyEl.innerHTML = `<div class="masonry" data-masonry></div>${
      items.length < total ? '<div class="inbox-more"><button class="tb-btn" data-more>加载更多</button></div>' : ''
    }`;
    const holder = bodyEl.querySelector('[data-masonry]');
    requestAnimationFrame(() => {
      renderMasonry(
        holder,
        items,
        (i, ev) => {
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
        },
        {
          selectable: selecting,
          isPicked: (it) => picked.has(it.id),
          spanWide: true,
          onContext: (e, item) => {
            e.preventDefault();
            e.stopPropagation();
            openMediaMenu(e, item);
          },
        }
      );
    });
    const more = bodyEl.querySelector('[data-more]');
    if (more) {
      more.addEventListener('click', async () => {
        more.disabled = true;
        more.textContent = '加载中…';
        page += 1;
        await load({ append: true });
      });
    }
    fadeIn(holder);
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
    renderGrid();
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

    async function loadChars(shelf) {
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
      if (!charDD) {
        charDD = createDropdown({
          options: opts,
          value: opts[0].value,
          allowEmpty: false,
          onChange: (v) => loadPacks(Number(v)),
        });
        slot.appendChild(charDD.el);
      } else {
        charDD.setOptions(opts);
        charDD.setValue(opts[0].value);
      }
      await loadPacks(Number(opts[0].value));
    }

    const shelfDD = createDropdown({
      options: shelves.map((s) => ({ value: String(s.id), label: s.name })),
      value: String(shelves[0].id),
      allowEmpty: false,
      onChange: (v) => loadChars(Number(v)),
    });
    mask.querySelector('[data-slot-shelf]').appendChild(shelfDD.el);
    await loadChars(Number(shelves[0].id));

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
  renderGrid();

  return () => document.removeEventListener('keydown', onKey);
}
