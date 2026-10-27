import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast, debounce, deleteSummary } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openContextMenu } from '../components/context-menu.js';
import { mediaMenu } from '../components/media-actions.js';
import { applyPickClick } from '../selection.js';
import { escDepth } from '../esc.js';
import { addMediaMenuItems } from '../components/media-picker.js';
import { createDropdown } from '../components/dropdown.js';
import { createPackSort, sortPacks } from '../components/pack-sort.js';
import { bindDropUpload } from '../components/dropzone.js';
import { queue } from '../upload-queue.js';

/**
 * 动图 = 真有多帧（服务端 anim 标记，按 sharp 的 pages 算）。
 * 别用 ext === 'gif' —— 微信/QQ 导出的表情里大量 .gif 只有一帧，其实是静态图。
 */
const isAnim = (m) => !!m.anim;

const SORTS = [
  { value: 'new', label: '最新添加' },
  { value: 'old', label: '最早添加' },
  { value: 'name', label: '按名称' },
  { value: 'size', label: '文件最大' },
  { value: 'sizeAsc', label: '文件最小' },
];

/** 打开媒体详情页 */
function gotoMedia(mediaId) {
  // from 带上 ?tab=，否则从详情页退回来只会落在「图包」分区
  history.pushState({ from: location.pathname + location.search }, {}, `/i/${mediaId}`);
  window.dispatchEvent(new CustomEvent('app:route'));
}

/**
 * 表情库：扁平库，没有条目层级。
 * 库里直接就是「图包 / 未分类 / 全部素材」三类，图包用前 9 张图拼成封面。
 */
export async function EmojiView(root, shelfId, opts = {}) {
  /* 嵌入首页时不自带顶栏：顶栏和库切换条由 LibraryView 提供 */
  const embedded = !!opts.embedded;
  let data = await api.emojiShelf(shelfId);
  let shelf = data.shelf;
  let packs = data.packs;
  let mediaAll = [];
  let mediaItems = [];
  let mediaLoaded = false;
  // 分区记在历史项里（history.state.emojiTab）。以前写进 URL（/e/:id?tab=xx），
  // 现在库是嵌在首页 /s/:id 里打开的，一改 URL 就把人带出首页、刷新后还落到旧页面
  let mode =
    (history.state && history.state.emojiTab) || new URLSearchParams(location.search).get('tab') || 'packs';
  let selecting = false;
  const picked = new Set();
  const filters = { kind: '', tag: '', pack: '', q: '', sort: 'new' };
  let tagDD = null;
  let packDD = null;
  let sortDD = null;
  // 图包卡片的排序（只在「图包」分区显示；未分类 / 全部素材用的是筛选条里那个排序）
  let packSort = { key: 'count', desc: true };
  let packSortCtl = null;

  root.innerHTML =
    (embedded
      ? ''
      : topbarHtml({
          back: true,
          title: shelf.name,
          sub: '',
          actions: `<button class="tb-btn" data-edit>编辑库</button>`,
        })) +
    `<main class="page">
       <div class="shelf-head">
         <div class="sh-main">
           <h1 class="sh-title" data-shelf-name>${esc(shelf.name)}</h1>
           <div class="sh-meta" data-shelf-meta></div>
         </div>
         <span class="spacer"></span>
         <button class="tb-btn" data-select-toggle>选取</button>
         <button class="tb-btn" data-new-pack>＋ 图包</button>
         <button class="tb-btn primary" data-upload>↑ 上传素材</button>
       </div>
       <div class="toolbar">
         <div class="segmented" data-view>
           <button class="on" data-v="packs">图包<i>0</i></button>
           <button data-v="loose">未分类<i>0</i></button>
           <button data-v="all">全部素材<i>0</i></button>
         </div>
         <div class="filter-bar" data-filter-bar hidden>
           <div class="segmented" data-f-kind>
             <button class="on" data-k="">全部</button>
             <button data-k="anim">动图</button>
             <button data-k="still">表情</button>
           </div>
           <span data-f-tag></span>
           <span data-f-pack></span>
           <label class="search filter-search">
             <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
               <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
             </svg>
             <input type="search" placeholder="搜索名称或标签" autocomplete="off" spellcheck="false" />
           </label>
           <span data-f-sort></span>
         </div>
         <span class="spacer"></span>
         <span class="count" data-count></span>
         <span data-pack-sort></span>
       </div>
       <div data-body></div>
       <div class="sel-bar" data-selbar hidden></div>
     </main>`;

  if (!embedded) bindTopbar(root);

  const bodyEl = root.querySelector('[data-body]');
  const selBar = () => root.querySelector('[data-selbar]');

  // 图包卡片排序（默认素材数量从多到少）
  packSortCtl = createPackSort({
    key: packSort.key,
    desc: packSort.desc,
    onChange: (key, desc) => {
      packSort = { key, desc };
      if (mode === 'packs') renderPacks();
    },
  });
  root.querySelector('[data-pack-sort]').replaceWith(packSortCtl.el);
  packSortCtl.el.style.display = mode === 'packs' ? '' : 'none';

  // ---------- 顶部信息 ----------
  function paintHead() {
    const s = data.stats;
    root.querySelector('[data-shelf-name]').textContent = shelf.name;
    const parts = [
      `${fmtNum(s.packs)} 个图包`,
      `${fmtNum(s.total)} 个素材`,
      s.anim ? `${fmtNum(s.anim)} 个动图` : '',
      s.loose ? `${fmtNum(s.loose)} 个未分类` : '',
      fmtBytes(s.bytes),
    ].filter(Boolean);
    root.querySelector('[data-shelf-meta]').textContent = parts.join(' · ');
    document.title = `${shelf.name} · 资料库`;
  }

  function paintTabs() {
    const s = data.stats;
    const counts = { packs: s.packs, loose: s.loose, all: s.total };
    root.querySelectorAll('[data-view] button').forEach((b) => {
      const i = b.querySelector('i');
      if (i) i.textContent = fmtNum(counts[b.dataset.v] || 0);
      b.classList.toggle('on', b.dataset.v === mode);
    });
  }

  // ---------- 图包 ----------
  function mosaicHtml(p) {
    const ids = p.thumbs || [];
    const n = ids.length;
    if (!n) return '<div class="mosaic is-empty"><span>空</span></div>';
    const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
    const cells = ids
      .map((id) => `<img src="${api.thumb(id)}" alt="" loading="lazy" decoding="async">`)
      .join('');
    const blanks = Array.from({ length: cols * cols - n }, () => '<i class="ph"></i>').join('');
    return `<div class="mosaic c${cols}">${cells}${blanks}</div>`;
  }

  function packCardHtml(p) {
    const on = selecting && picked.has(p.id);
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const meta = [`${fmtNum(p.mediaCount)} 个`, p.animCount ? `${fmtNum(p.animCount)} 动图` : '']
      .filter(Boolean)
      .join(' · ');
    return `<div class="pack-card emoji-card${on ? ' is-sel' : ''}" data-pack="${p.id}">
      ${selecting ? '<span class="tick" aria-hidden="true"></span>' : ''}
      <a class="pack-hit" href="/p/${p.id}" data-link aria-label="${esc(p.title)}"></a>
      ${mosaicHtml(p)}
      <div class="info">
        <div class="t">${esc(p.title)}</div>
        <div class="m">${meta}</div>
        ${tags.length ? `<div class="ptags">${tags.slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }

  /** 图包按当前排序排好（不修改 packs 本身） */
  function sortedPacks() {
    return sortPacks(packs, packSort.key, packSort.desc);
  }

  function renderPacks() {
    mediaItems = [];
    syncCount();
    if (!packs.length) {
      bodyEl.innerHTML = `<div class="empty">
        <b>还没有图包</b>点「＋ 图包」建一个，或者直接把表情包文件夹拖进来（会进未分类）
      </div>`;
      return;
    }
    bodyEl.innerHTML = `<div class="pack-grid emoji-grid" data-packs>${sortedPacks().map(packCardHtml).join('')}</div>`;
    bodyEl.querySelectorAll('img').forEach(fadeIn);

    const holder = bodyEl.querySelector('[data-packs]');
    // 选择模式下点卡片 = 勾选，捕获阶段拦住 .pack-hit 的跳转
    if (selecting) {
      holder.addEventListener(
        'click',
        (e) => {
          const card = e.target.closest('.emoji-card');
          if (!card) return;
          e.preventDefault();
          e.stopPropagation();
          pickByClick(Number(card.dataset.pack), e);
        },
        true
      );
    }
  }

  // ---------- 媒体的筛选 ----------
  function buildFilterBar() {
    const bar = root.querySelector('[data-filter-bar]');
    if (!bar) return;

    tagDD = createDropdown({
      allowEmpty: true,
      emptyLabel: '全部标签',
      onChange: (v) => {
        filters.tag = v;
        renderMedia();
      },
    });
    bar.querySelector('[data-f-tag]').replaceWith(tagDD.el);

    packDD = createDropdown({
      allowEmpty: true,
      emptyLabel: '全部图包',
      onChange: (v) => {
        filters.pack = v;
        renderMedia();
      },
    });
    bar.querySelector('[data-f-pack]').replaceWith(packDD.el);

    sortDD = createDropdown({
      options: SORTS,
      value: 'new',
      allowEmpty: false,
      onChange: (v) => {
        filters.sort = v;
        renderMedia();
      },
    });
    bar.querySelector('[data-f-sort]').replaceWith(sortDD.el);

    bar.querySelector('[data-f-kind]').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-k]');
      if (!btn) return;
      filters.kind = btn.dataset.k;
      bar.querySelectorAll('[data-f-kind] button').forEach((b) => b.classList.toggle('on', b === btn));
      renderMedia();
    });

    const search = bar.querySelector('.filter-search input');
    search.addEventListener(
      'input',
      debounce(() => {
        filters.q = search.value.trim();
        renderMedia();
      }, 220)
    );
  }

  function refreshFilterOptions() {
    if (!tagDD) return;
    // 候选标签跟着当前范围走：未分类里就不该出现只属于图包的标签
    const scope = mode === 'loose' ? mediaAll.filter((m) => !m.packId) : mediaAll;
    const counts = new Map();
    for (const m of scope) {
      for (const t of m.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    tagDD.setOptions(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
        .map(([t, n]) => ({ value: t, label: `${t}（${n}）` }))
    );
    packDD.setOptions([
      { value: '__none__', label: '未分类（未归包）' },
      ...packs.map((p) => ({ value: String(p.id), label: `${p.title}（${p.mediaCount}）` })),
    ]);
  }

  function applyFilters() {
    let out = mode === 'loose' ? mediaAll.filter((m) => !m.packId) : mediaAll.slice();
    if (filters.kind === 'anim') out = out.filter(isAnim);
    else if (filters.kind === 'still') out = out.filter((m) => !isAnim(m));
    if (filters.tag) out = out.filter((m) => (m.tags || []).includes(filters.tag));
    if (mode === 'all' && filters.pack) {
      out =
        filters.pack === '__none__'
          ? out.filter((m) => !m.packId)
          : out.filter((m) => String(m.packId) === filters.pack);
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      out = out.filter(
        (m) =>
          (m.fileName || '').toLowerCase().includes(q) ||
          (m.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    const sorted = out.slice();
    if (filters.sort === 'old') sorted.sort((a, b) => a.id - b.id);
    else if (filters.sort === 'name')
      sorted.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh-Hans-CN'));
    else if (filters.sort === 'size') sorted.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    else if (filters.sort === 'sizeAsc') sorted.sort((a, b) => (a.bytes || 0) - (b.bytes || 0));
    else sorted.sort((a, b) => b.id - a.id);
    return sorted;
  }

  function syncCount() {
    const el = root.querySelector('[data-count]');
    if (!el) return;
    if (mode === 'packs') {
      // 图包数已经写在 tab 上了，这里留给筛选结果
      el.textContent = '';
      return;
    }
    const base = mode === 'loose' ? mediaAll.filter((m) => !m.packId).length : mediaAll.length;
    el.textContent =
      mediaItems.length === base
        ? `${fmtNum(base)} 个素材`
        : `${fmtNum(mediaItems.length)} / ${fmtNum(base)} 个素材`;
  }

  function renderMedia() {
    mediaItems = applyFilters();
    syncCount();
    if (!mediaLoaded) return;
    bodyEl.innerHTML = '<div class="masonry" data-masonry></div>';
    const holder = bodyEl.querySelector('[data-masonry]');
    if (!mediaItems.length) {
      const looseEmpty = mode === 'loose' && !mediaAll.some((m) => !m.packId);
      holder.innerHTML = looseEmpty
        ? '<div class="empty" style="flex:1"><b>未分类是空的</b>上传时没指定图包的表情会落在这里</div>'
        : mediaAll.length
          ? '<div class="empty" style="flex:1"><b>没有符合条件的素材</b>换个筛选条件试试</div>'
          : '<div class="empty" style="flex:1"><b>还没有素材</b>把表情包拖进来，或者点右上角上传</div>';
      return;
    }
    requestAnimationFrame(() => {
      renderMasonry(
        holder,
        mediaItems,
        (i, ev) => {
          if (selecting) {
            pickByClick(mediaItems[i].id, ev);
            return;
          }
          gotoMedia(mediaItems[i].id);
        },
        {
          selectable: selecting,
          isPicked: (it) => picked.has(it.id),
          onContext: selecting
            ? null
            : (e, item) =>
                mediaMenu(e, item, {
                  characterId: data.containerId,
                  onOpen: () => gotoMedia(item.id),
                  onChange: reload,
                  pack: item.packId
                    ? { id: item.packId, title: (packs.find((p) => p.id === item.packId) || {}).title || '这个图包' }
                    : null,
                  // 表情库的条目是容器，没有「人物 / 角色」这一层
                  owner: null,
                  shelfKind: (shelf && shelf.kind) || 'emoji',
                  onCover: () => reload(),
                }),
        }
      );
    });
  }

  async function ensureMedia(force = false) {
    if (mediaLoaded && !force) return;
    const res = await api.characterMedia(data.containerId);
    mediaAll = res.items;
    mediaLoaded = true;
    refreshFilterOptions();
  }

  async function switchMode(next) {
    if (next === mode) return;
    mode = next;
    // 刷新、从详情页返回都要回到同一个分区：写历史项，不动 URL
    try {
      history.replaceState({ ...(history.state || {}), emojiTab: next }, '', location.href);
    } catch {
      /* 隐私模式下写不了就算了，分区退回图包 */
    }
    resetSelection();
    paintTabs();
    const bar = root.querySelector('[data-filter-bar]');
    if (bar) bar.hidden = mode === 'packs';
    if (packSortCtl) packSortCtl.el.style.display = mode === 'packs' ? '' : 'none';
    if (packDD) packDD.el.hidden = mode !== 'all';
    if (mode === 'packs') {
      renderPacks();
      return;
    }
    bodyEl.innerHTML = '<div class="masonry" data-masonry></div>';
    await ensureMedia();
    refreshFilterOptions();
    renderMedia();
  }

  async function reload() {
    const [fresh, media] = await Promise.all([
      api.emojiShelf(shelfId),
      api.characterMedia(data.containerId),
    ]);
    data = fresh;
    shelf = fresh.shelf;
    packs = fresh.packs;
    mediaAll = media.items;
    mediaLoaded = true;
    paintHead();
    paintTabs();
    refreshFilterOptions();
    if (mode === 'packs') renderPacks();
    else renderMedia();
  }

  // ---------- 多选 ----------
  function resetSelection() {
    selecting = false;
    picked.clear();
    anchorId = null;
    const bar = selBar();
    if (bar) {
      bar.hidden = true;
      bar.innerHTML = '';
    }
    const t = root.querySelector('[data-select-toggle]');
    if (t) t.textContent = '选取';
    root.classList.remove('is-selecting');
  }

  function syncSelCount() {
    const bar = selBar();
    if (!bar || bar.hidden) return;
    const n = bar.querySelector('.sel-n b');
    if (n) n.textContent = String(picked.size);
    bar.querySelectorAll('button[data-sel]').forEach((b) => {
      const k = b.dataset.sel;
      b.disabled = picked.size === 0 && k !== 'all' && k !== 'exit';
    });
  }

  function buildSelBar() {
    const bar = selBar();
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = `
      <span class="sel-n">已选 <b>0</b> ${mode === 'packs' ? '个图包' : '个素材'}</span>
      <button data-sel="all">全选</button>
      ${mode === 'packs' ? '<button data-sel="dissolve">解散</button>' : '<button data-sel="move">移动图包…</button>'}
      <button data-sel="del" class="danger">删除</button>
      <button data-sel="exit" class="primary">完成</button>`;
    bar.querySelectorAll('button[data-sel]').forEach((b) => {
      b.addEventListener('click', () => onSelAction(b.dataset.sel));
    });
    syncSelCount();
  }

  function enterSelect() {
    selecting = true;
    picked.clear();
    root.classList.add('is-selecting');
    const t = root.querySelector('[data-select-toggle]');
    if (t) t.textContent = '完成';
    if (mode === 'packs') renderPacks();
    else renderMedia();
    buildSelBar();
  }

  function exitSelect() {
    resetSelection();
    if (mode === 'packs') renderPacks();
    else renderMedia();
  }

  /** 勾选锚点：Shift 连选从它算起 */
  let anchorId = null;

  function syncPickMarks() {
    root.querySelectorAll('.tile[data-id], .emoji-card[data-pack]').forEach((el) => {
      const id = Number(el.dataset.id || el.dataset.pack);
      el.classList.toggle('is-sel', picked.has(id));
    });
    syncSelCount();
  }

  function pickByClick(id, ev) {
    const ordered = mode === 'packs' ? packs.map((p) => p.id) : mediaItems.map((m) => m.id);
    const r = applyPickClick({ picked, ordered, id, ev, anchorId });
    anchorId = r.anchorId;
    syncPickMarks();
  }

  function selectAllShown() {
    const ids = mode === 'packs' ? packs.map((p) => p.id) : mediaItems.map((m) => m.id);
    const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
    if (allOn) picked.clear();
    else ids.forEach((id) => picked.add(id));
    anchorId = ids.length ? ids[ids.length - 1] : null;
    root.querySelectorAll('.emoji-card, .tile').forEach((el) => {
      const id = Number(el.dataset.pack || el.dataset.id);
      el.classList.toggle('is-sel', picked.has(id));
    });
    syncSelCount();
  }

  function onSelAction(action) {
    if (action === 'exit') return exitSelect();
    if (action === 'all') return selectAllShown();
    if (!picked.size) return;
    if (action === 'dissolve') return bulkPacks('dissolve');
    if (action === 'del') return mode === 'packs' ? bulkPacks('delete') : bulkMediaDelete();
    if (action === 'move') return bulkMediaMove();
  }

  async function bulkPacks(action) {
    const ids = [...picked];
    const del = action === 'delete';
    const ok = await confirmDialog(
      del ? `删除 ${ids.length} 个图包和里面的素材？` : `解散 ${ids.length} 个图包？`,
      del
        ? '图包里的表情会一起删掉，磁盘文件也会删，不可恢复。'
        : '只删图包这个壳，里面的素材会变成未分类，文件一个都不动。'
    );
    if (!ok) return;
    try {
      const res = await api.bulkPacks(ids, action);
      toast(del ? `已删除 ${res.done} 个图包 · ${res.removed} 个素材` : `已解散 ${res.done} 个图包`);
      resetSelection();
      await reload();
    } catch (err) {
      toast(err.message || '操作失败');
    }
  }

  async function bulkMediaDelete() {
    const ids = [...picked];
    const ok = await confirmDialog(`删除 ${ids.length} 个素材？`, '磁盘上的原件也会一起删掉，不可恢复。');
    if (!ok) return;
    try {
      const res = await api.bulkMedia(ids, 'delete');
      toast(deleteSummary(res, '素材'));
      resetSelection();
      await reload();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  async function bulkMediaMove() {
    const v = await openModal({
      title: `移动 ${picked.size} 个素材`,
      description: '只改所属图包，磁盘文件留在原地。',
      fields: [
        {
          name: 'packId',
          label: '目标图包',
          type: 'select',
          options: [
            { value: '__new__', label: '＋ 新建图包…' },
            { value: '__none__', label: '移出图包（变成未分类）' },
            ...packs.map((p) => ({ value: String(p.id), label: `${p.title}（${p.mediaCount}）` })),
          ],
          value: packs.length ? String(packs[0].id) : '__new__',
        },
      ],
      submitText: '移动',
    });
    if (!v) return;

    let packId = v.packId === '__none__' ? null : Number(v.packId);
    if (v.packId === '__new__') {
      const nv = await openModal({
        title: '新建图包',
        description: '建好后这些素材会直接移进去。',
        fields: [{ name: 'title', label: '图包名称', required: true, placeholder: '比如：猫猫、打工日常' }],
        submitText: '创建并移动',
      });
      if (!nv) return;
      try {
        const created = await api.createPack(data.containerId, { title: nv.title });
        packId = created.id;
      } catch (err) {
        toast(err.message || '创建失败');
        return;
      }
    }

    try {
      if (packId) {
        const res = await api.bulkMedia([...picked], 'move', packId);
        toast(res.skipped ? `已移动 ${res.done} 个，跳过 ${res.skipped} 个` : `已移动 ${res.done} 个`);
      } else {
        // 移出图包 = 逐个把 packId 置空（批量接口只支持移入）
        for (const id of picked) await api.updateMedia(id, { packId: null });
        toast(`已移出 ${picked.size} 个图包`);
      }
      resetSelection();
      await reload();
    } catch (err) {
      toast(err.message || '移动失败');
    }
  }

  // ---------- 图包操作 ----------
  function addMediaItems(pack) {
    return addMediaMenuItems({
      charId: data.containerId,
      charName: shelf.name,
      packId: pack.id,
      packTitle: pack.title,
      selfLabel: '本库',
      onUpload: () => pickFiles({ packId: pack.id, packTitle: pack.title }),
      onDone: reload,
    });
  }

  async function renamePack(pack) {
    const v = await openModal({
      title: '重命名图包',
      fields: [{ name: 'title', label: '名称', value: pack.title, required: true }],
      submitText: '保存',
    });
    if (!v) return;
    await api.updatePack(pack.id, { title: v.title });
    toast('已重命名');
    reload();
  }

  async function editPackTags(pack) {
    const next = await openTagPicker({ title: '编辑图包标签', selected: pack.tags || [] });
    if (!next) return;
    await api.updatePack(pack.id, { tags: next });
    toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
    reload();
  }

  async function dissolvePack(pack) {
    const ok = await confirmDialog(
      '解散这个图包？',
      `「${pack.title}」里的 ${pack.mediaCount} 个素材会变成未分类，不会被删除。`
    );
    if (!ok) return;
    await api.deletePack(pack.id);
    toast('图包已解散');
    reload();
  }

  async function removePack(pack) {
    const ok = await confirmDialog(
      '删除图包和它的素材？',
      `「${pack.title}」里的 ${pack.mediaCount} 个素材会一起删除，磁盘文件也会删掉，不可恢复。`
    );
    if (!ok) return;
    await api.deletePack(pack.id, { withMedia: true });
    toast('图包已删除');
    reload();
  }

  function bindContextMenus() {
    const page = root.querySelector('.page');
    page.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tile')) return;

      const card = e.target.closest('.emoji-card');
      if (card) {
        const pack = packs.find((p) => p.id === Number(card.dataset.pack));
        if (!pack) return;
        openContextMenu(e, [
          { label: '打开', onClick: () => gotoPack(pack.id) },
          { label: '编辑名称', onClick: () => renamePack(pack) },
          { label: '编辑标签', onClick: () => editPackTags(pack) },
          { label: '添加素材', hint: '4 种来源', children: addMediaItems(pack) },
          { label: '打开本地文件夹', onClick: () => api.reveal('pack', pack.id).catch(() => toast('目录已丢失')) },
          { separator: true },
          { label: '解散图包', hint: '保留素材', onClick: () => dissolvePack(pack) },
          { label: '删除', danger: true, hint: '连素材', onClick: () => removePack(pack) },
        ]);
        return;
      }

      openContextMenu(e, [
        { label: '上传素材', hint: '也可以直接拖进来', onClick: () => pickFiles() },
        { label: '打开上传队列', onClick: () => { history.pushState({}, '', '/uploads'); window.dispatchEvent(new CustomEvent('app:route')); } },
        { label: '新建图包', onClick: () => root.querySelector('[data-new-pack]').click() },
        { separator: true },
        // 嵌入首页时这颗按钮在 LibraryView 的顶栏里，菜单里就不重复放一个点了没反应的项
        ...(root.querySelector('[data-edit]')
          ? [{ label: '编辑库', onClick: () => root.querySelector('[data-edit]').click() }]
          : []),
      ]);
    });
  }

  function gotoPack(packId) {
    history.pushState({}, '', `/p/${packId}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  // ---------- 上传 ----------
  function pickFiles({ packId = null, packTitle = '' } = {}) {
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
      const n = queue.enqueue(files, {
        charId: data.containerId,
        charName: shelf.name,
        packId,
        packTitle,
        category: null,
      });
      toast(n ? `已加入上传队列 ${n} 个文件 · 点右下角看进度` : '这些文件已经在队列里了');
    });
    input.click();
  }

  // ---------- 绑定 ----------
  root.querySelector('[data-view]').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (btn) switchMode(btn.dataset.v);
  });

  root.querySelector('[data-select-toggle]').addEventListener('click', () => {
    if (selecting) exitSelect();
    else enterSelect();
  });

  root.querySelector('[data-new-pack]').addEventListener('click', async () => {
    const v = await openModal({
      title: '新建图包',
      description: '表情包按主题分堆放：猫猫、打工日常、表情大合集…',
      fields: [{ name: 'title', label: '图包名称', required: true, placeholder: '比如：猫猫' }],
      submitText: '创建',
    });
    if (!v) return;
    try {
      const created = await api.createPack(data.containerId, { title: v.title });
      toast(`图包「${created.title}」已创建`);
      if (mode !== 'packs') {
        mode = 'packs';
        const bar = root.querySelector('[data-filter-bar]');
        if (bar) bar.hidden = true;
      }
      paintTabs();
      await reload();
      renderPacks();
    } catch (err) {
      toast(err.message || '创建失败');
    }
  });

  // 嵌入首页时没有这颗按钮（由 LibraryView 统一提供），绑定必须可选
  root.querySelector('[data-edit]')?.addEventListener('click', async () => {
    const v = await openModal({
      title: '编辑库',
      fields: [{ name: 'name', label: '库名称', value: shelf.name, required: true }],
      submitText: '保存',
    });
    if (!v) return;
    try {
      await api.patch(`/api/shelves/${shelfId}`, { name: v.name });
      shelf.name = v.name;
      paintHead();
      toast('已保存');
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });

  root.querySelector('[data-upload]').addEventListener('click', () => pickFiles());

  queue.onIdle = () => {
    if (!root.isConnected || !root.querySelector('.page')) return;
    reload().catch(() => {});
  };

  bindDropUpload(root.querySelector('.page'), () => ({
    charId: data.containerId,
    charName: shelf.name,
    packId: null,
    packTitle: '',
    category: null,
  }));

  buildFilterBar();
  bindContextMenus();
  paintHead();

  /** Esc 退出选取。弹窗 / 右键菜单 / 下拉开着时，esc 栈会先把事件吃掉，轮不到这里 */
  const onPageKey = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (escDepth() > 0) return;
    if (!selecting) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSelect();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!picked.size) return;
      e.preventDefault();
      onSelAction('del');
      return;
    }
    if (e.key === 'Enter' && picked.size === 1) {
      e.preventDefault();
      const only = [...picked][0];
      if (mode === 'packs') gotoPack(only);
      else gotoMedia(only);
    }
  };
  document.addEventListener('keydown', onPageKey);

  const wanted = new URLSearchParams(location.search).get('tab');
  mode = wanted === 'loose' || wanted === 'all' ? wanted : 'packs';
  const filterBar = root.querySelector('[data-filter-bar]');
  if (filterBar) filterBar.hidden = mode === 'packs';
  if (packDD) packDD.el.hidden = mode !== 'all';
  paintTabs();

  if (mode === 'packs') {
    renderPacks();
    syncCount();
  } else {
    bodyEl.innerHTML = '<div class="masonry" data-masonry></div>';
    await ensureMedia();
    refreshFilterOptions();
    renderMedia();
  }

  return () => document.removeEventListener('keydown', onPageKey);
}
