import { api } from '../api.js';
import { esc, fmtNum, toast, fadeIn, debounce, deleteSummary } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { createDropdown } from '../components/dropdown.js';
import { confirmDialog } from '../components/modal.js';
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
          gotoMedia(items[i].id);
        },
        {
          selectable: selecting,
          isPicked: (it) => picked.has(it.id),
          spanWide: true,
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

  function enterSelect() {
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

  /** Esc 退出选取（弹窗 / 下拉开着时归它们管） */
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (escDepth() > 0) return;
    if (!selecting) return;
    e.preventDefault();
    exitSelect();
  };
  document.addEventListener('keydown', onKey);

  paintMeta();
  paintTabs();
  renderGrid();

  return () => document.removeEventListener('keydown', onKey);
}
