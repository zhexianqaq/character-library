import { api } from '../api.js';
import { esc, fmtNum, toast, deleteSummary, keepScroll } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openContextMenu, openMenuAtPoint } from '../components/context-menu.js';
import { mediaMenu } from '../components/media-actions.js';
import { packOptions, matchPack } from '../components/pack-choice.js';
import { sortMedia, createMediaSort, mediaSortState, setMediaSort } from '../components/media-sort.js';
import { addMediaMenuItems } from '../components/media-picker.js';
import { bindDropUpload } from '../components/dropzone.js';
import { queue } from '../upload-queue.js';
import { applyPickClick } from '../selection.js';
import { togglePackKind } from '../components/pack-kind.js';
import { escDepth } from '../esc.js';

/** 有拍摄月份就显示月份；没有就用创建日期 */
function packDateLabel(pack) {
  if (pack.month) return pack.month;
  const d = new Date(pack.createdAt || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 打开漫画阅读器，从第 page 页开始 */
function gotoComic(packId, page = 1) {
  history.pushState({ from: location.pathname }, '', `/cm/${packId}${page > 1 ? `?p=${page}` : ''}`);
  window.dispatchEvent(new CustomEvent('app:route'));
}

/** 打开媒体详情页 */
function gotoMedia(mediaId) {
  history.pushState({ from: location.pathname }, {}, `/i/${mediaId}`);
  window.dispatchEvent(new CustomEvent('app:route'));
}

export async function PackView(root, id) {
  const [pack, media] = await Promise.all([api.pack(id), api.packMedia(id)]);
  let items = media.items;
  // 表情库的图包挂在容器条目下，面包屑要回到库页而不是条目页
  const shelfKind = (pack.shelf && pack.shelf.kind) || 'people';
  // 漫画包：页序由 media.page_no 决定，和「图包排序」是两回事
  const isComic = pack.kind === 'comic';
  // 真人（人物库）里是照片合集，不给「转成漫画」；小说袋也由后端拒绝
  const canComic = shelfKind !== 'people' && shelfKind !== 'novel';
  const lastPage = (() => {
    if (!isComic) return 0;
    try {
      return Number(JSON.parse(localStorage.getItem(`cl-comic:${id}`) || 'null')) || 0;
    } catch {
      return 0;
    }
  })();
  // 散图库和表情库一样是扁平库：没有条目这一层，图包也不做跨列排版
  const emoji = shelfKind === 'emoji' || shelfKind === 'loose';
  const resource = shelfKind === 'resource';
  const ownerNoun = shelfKind === 'work' ? '角色' : resource ? '资源' : '人物';
  // 资源库的图包回到资源详情（/r/:id），别把人带到条目页
  const crumbHref = emoji ? `/s/${pack.shelf.id}` : resource ? `/r/${pack.character.id}` : `/c/${pack.character.id}`;
  const crumbName = emoji ? pack.shelf.name : pack.character.name;

  root.innerHTML =
    topbarHtml({ back: true, sub: '', actions: `<button class="tb-btn" data-rename>编辑</button>` }) +
    `<main class="page">
       <div class="toolbar">
         <div style="min-width:0">
           <div class="crumb"><a href="${crumbHref}" data-link>${esc(crumbName)}</a></div>
           <div class="title-row">
             <h1 class="page-title" data-title>${esc(pack.title)}</h1>
             <span class="pack-date" data-date>${esc(packDateLabel(pack))}</span>
             ${isComic ? '<span class="kind-chip">漫画</span>' : ''}
             <span class="pack-tags" data-pack-tags></span>
           </div>
         </div>
         <span class="spacer"></span>
         <span class="count" data-count></span>
         ${isComic && lastPage > 1 ? `<span class="comic-resume">读到第 ${lastPage} 页</span>` : ''}
         <span data-media-sort></span>
         <button class="tb-btn" data-select-toggle>选取</button>
         ${isComic ? '<button class="tb-btn primary" data-read>阅读</button>' : ''}
         <button class="tb-btn" data-add-media>＋ 添加素材</button>
       </div>
       <div class="masonry" data-masonry></div>
       <div class="sel-bar" data-selbar hidden></div>
     </main>`;

  bindTopbar(root);

  let selecting = false;
  const picked = new Set();

  const holder = root.querySelector('[data-masonry]');
  const titleEl = root.querySelector('[data-title]');
  const dateEl = root.querySelector('[data-date]');
  const countEl = root.querySelector('[data-count]');
  const addBtn = root.querySelector('[data-add-media]');

  /** 图包标签挂在日期右边，跟在标题行里 */
  function paintPackTags() {
    const el = root.querySelector('[data-pack-tags]');
    if (!el) return;
    const tags = Array.isArray(pack.tags) ? pack.tags : [];
    el.innerHTML = tags
      .map(
        (t) =>
          `<button class="pack-tag" data-ptag="${esc(t)}" title="查看标签「${esc(t)}」">${esc(t)}</button>`
      )
      .join('');
    el.hidden = !tags.length;
    // 标签点一下 = 这个标签下有什么（条目 / 图包 / 素材）
    el.querySelectorAll('[data-ptag]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        history.pushState(
          { from: location.pathname + location.search },
          '',
          `/tag/${encodeURIComponent(btn.dataset.ptag)}`
        );
        window.dispatchEvent(new CustomEvent('app:route'));
      });
    });
  }

  function syncCount() {
    if (isComic) {
      const pages = items.filter((m) => m.kind === 'image').length;
      const videos = items.filter((m) => m.kind === 'video').length;
      countEl.textContent = `${fmtNum(pages)} 页${videos ? ` · ${videos} 个视频未参与` : ''}`;
      return;
    }
    countEl.textContent = `${fmtNum(items.length)} 项${pack.counts && pack.counts.video ? ` · ${pack.counts.video} 个视频` : ''}`;
  }

  /** 漫画：图片按 page_no 升序在前，视频（没有页序）排到最后 */
  function comicOrder(list) {
    return [...list].sort((a, b) => {
      const pa = a.pageNo == null ? Number.MAX_SAFE_INTEGER : a.pageNo;
      const pb = b.pageNo == null ? Number.MAX_SAFE_INTEGER : b.pageNo;
      if (pa !== pb) return pa - pb;
      if (a.kind !== b.kind) return a.kind === 'image' ? -1 : 1;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  }

  /** 当前展示顺序（排序后的副本）：点击、Shift 连选、全选都按这个顺序算 */
  let shown = [];

  function paintMedia() {
    syncCount();
    // 漫画的页序是固定的（page_no），不能被「图包排序」改掉
    shown = isComic ? comicOrder(items) : sortMedia(items, mediaSortState.key, mediaSortState.desc);
    holder.innerHTML = '';
    if (!shown.length) {
      holder.innerHTML = isComic
        ? '<div class="empty" style="flex:1"><b>这本漫画还没有页</b>点右上角「添加素材」放图片进来，页序按文件名里的数字排（1 → 2 → 10）</div>'
        : '<div class="empty" style="flex:1"><b>这个图包是空的</b>点右上角「添加素材」，从已有素材里挑，或者把文件拖进来</div>';
      return;
    }
    requestAnimationFrame(() => {
      renderMasonry(holder, shown, (i, ev) => {
        if (selecting) {
          pickByClick(shown[i].id, ev);
          return;
        }
        const it = shown[i];
        // 漫画里点图 = 从这一页开始读
        if (isComic && it.kind === 'image') {
          gotoComic(pack.id, it.pageNo || i + 1);
          return;
        }
        gotoMedia(it.id);
      }, {
        showPage: isComic,
        selectable: selecting,
        isPicked: (it) => picked.has(it.id),
        // 人物库 / 角色库的图包跟条目页保持同一套排版；表情库不动
        spanWide: !emoji,
        onContext: selecting
          ? null
          : (e, item) =>
              mediaMenu(e, item, {
                characterId: pack.character.id,
                onOpen: () => gotoMedia(item.id),
                onChange: reload,
                pack: { id: pack.id, title: pack.title },
                // 表情库挂在容器条目上，没有「人物 / 角色」可设
                owner: emoji ? null : { id: pack.character.id, name: pack.character.name, noun: ownerNoun },
                shelfKind: (pack.shelf && pack.shelf.kind) || '',
                // 滚到下面时顶部「选取」按钮早就不在屏幕里了，右键也能进多选
                onSelect: enterSelect,
                onCover: async (kind) => {
                  if (kind !== 'pack') return;
                  const next = await api.pack(id);
                  pack.coverMediaId = next.coverMediaId;
                },
              }),
      });
    });
  }

  async function reload() {
    try {
      const [nextPack, nextMedia] = await Promise.all([api.pack(id), api.packMedia(id)]);
      pack.title = nextPack.title;
      pack.month = nextPack.month;
      pack.counts = nextPack.counts;
      pack.tags = nextPack.tags;
      paintPackTags();
      titleEl.textContent = nextPack.title;
      dateEl.textContent = packDateLabel(nextPack);
      items = nextMedia.items;
      paintMedia();
    } catch (err) {
      toast(err.message || '刷新失败');
    }
  }

  // ---------- 多选 ----------
  const selBar = () => root.querySelector('[data-selbar]');

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
      <span class="sel-n">已选 <b>0</b> 个媒体</span>
      <button data-sel="all">全选</button>
      <button data-sel="move">移动到…</button>
      <button data-sel="eject">移出库</button>
      <button data-sel="del" class="danger">删除</button>
      <button data-sel="exit" class="primary">完成</button>`;
    bar.querySelectorAll('button[data-sel]').forEach((b) => {
      b.addEventListener('click', () => onSelAction(b.dataset.sel));
    });
    syncSelCount();
  }

  function enterSelect() {
    // 重画会清空重建整个网格，先记住滚动位置，不然会跳回页面顶部
    keepScroll(() => {
      selecting = true;
      picked.clear();
      const t = root.querySelector('[data-select-toggle]');
      if (t) t.textContent = '完成';
      paintMedia();
      buildSelBar();
    });
  }

  function exitSelect() {
    keepScroll(() => {
      resetSelection();
      paintMedia();
    });
  }

  /** 勾选锚点：Shift 连选从它算起 */
  let anchorId = null;

  function syncPickMarks() {
    root.querySelectorAll('.tile[data-id]').forEach((el) => {
      el.classList.toggle('is-sel', picked.has(Number(el.dataset.id)));
    });
    syncSelCount();
  }

  function pickByClick(id, ev) {
    const r = applyPickClick({ picked, ordered: shown.map((m) => m.id), id, ev, anchorId });
    anchorId = r.anchorId;
    syncPickMarks();
  }

  function selectAllShown() {
    const ids = shown.map((m) => m.id);
    const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
    if (allOn) picked.clear();
    else ids.forEach((id) => picked.add(id));
    anchorId = ids.length ? ids[ids.length - 1] : null;
    root.querySelectorAll('.tile').forEach((el) => {
      el.classList.toggle('is-sel', picked.has(Number(el.dataset.id)));
    });
    syncSelCount();
  }

  async function onSelAction(action) {
    if (action === 'exit') {
      exitSelect();
      return;
    }
    if (action === 'all') {
      selectAllShown();
      return;
    }
    if (!picked.size) return;
    if (action === 'del') bulkDelete();
    else if (action === 'move') bulkMove();
    else if (action === 'eject') bulkEject();
  }

  async function bulkDelete() {
    const ids = [...picked];
    const ok = await confirmDialog(`删除 ${ids.length} 个媒体？`, '磁盘上的原件也会一起删掉，不可恢复。');
    if (!ok) return;
    try {
      const res = await api.bulkMedia(ids, 'delete');
      toast(deleteSummary(res, '媒体'));
      resetSelection();
      await reload();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  /** 批量移出库：退回「全部库 → 未分发」，文件跟着搬 */
  async function bulkEject() {
    const ids = [...picked];
    const ok = await confirmDialog(
      `把 ${ids.length} 个素材移出当前图包？`,
      '会移到「全部库 → 未分发」，之后可以在那里重新分发；磁盘上的文件跟着搬，不会复制。'
    );
    if (!ok) return;
    try {
      const r = await api.ejectMedia(ids);
      const bad = (r.skipped || []).length;
      toast(
        bad
          ? `已移出 ${r.moved} 个，${bad} 个没成功（${r.skipped[0].reason}）`
          : r.merged
            ? `已移出 ${r.moved} 个，${r.merged} 个与全部库重复已合并`
            : `已移出 ${r.moved} 个素材`
      );
      exitSelect();
      await reload();
    } catch (err) {
      toast(err.message || '移出失败');
    }
  }

  async function bulkMove() {
    let data;
    try {
      data = await api.packs(pack.character.id);
    } catch (err) {
      toast(err.message || '图包列表读取失败');
      return;
    }
    const others = data.items.filter((p) => p.id !== pack.id);
    const v = await openModal({
      title: `移动 ${picked.size} 个媒体`,
      description: '只改所属图包，磁盘文件留在原地。',
      fields: [
        {
          name: 'packId',
          label: '目标图包',
          type: 'select',
          required: true,
          // 直接在输入框里打名字：不是已有图包就新建，省掉「再弹一个窗」那一步
          editable: true,
          placeholder: others.length ? '选择或输入新图包名称' : '输入新图包名称',
          hint: '不是已有图包的名字，就会新建一个',
          options: packOptions(others),
          value: others.length ? String(others[0].id) : '',
        },
      ],
      submitText: '移动',
    });
    if (!v) return;

    const wanted = String(v.packId || '').trim();
    const hit = matchPack(others, wanted);
    let packId = hit ? hit.id : 0;
    if (!packId) {
      try {
        const created = await api.createPack(pack.character.id, {
          title: wanted.slice(0, 60),
          month: '',
          category: pack.category || null,
        });
        packId = created.id;
      } catch (err) {
        toast(err.message || '创建图包失败');
        return;
      }
    }

    try {
      const res = await api.bulkMedia([...picked], 'move', packId);
      toast(res.skipped ? `已移动 ${res.done} 个，跳过 ${res.skipped} 个` : `已移动 ${res.done} 个`);
      resetSelection();
      await reload();
    } catch (err) {
      toast(err.message || '移动失败');
    }
  }

  async function convertKind() {
    const changed = await togglePackKind(pack);
    if (!changed) return;
    // 类型变了，整页要按新类型重画（工具栏、排序控件、点击行为都不同）
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  function addMediaItems() {
    return addMediaMenuItems({
      charId: pack.character.id,
      charName: emoji ? pack.shelf.name : pack.character.name,
      packId: pack.id,
      packTitle: pack.title,
      // 表情库没有条目，菜单里不能写「从本角色素材添加」
      selfLabel: emoji ? '本库' : '本角色',
      onUpload: () => pickFiles(),
      onDone: reload,
    });
  }

  function openAddMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenuAtPoint(Math.min(window.innerWidth - 16, r.right), r.bottom + 6, addMediaItems());
  }

  /** 上传到当前图包 */
  function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,.zip,.rar,.7z,.tgz,.tar';
    input.style.display = 'none';
    root.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;
      const n = queue.enqueue(files, {
        charId: pack.character.id,
        charName: pack.character.name,
        packId: pack.id,
        packTitle: pack.title,
        category: pack.category || null,
      });
      toast(n ? `已加入上传队列 ${n} 个文件 · 点右下角看进度` : '这些文件已经在队列里了');
    });
    input.click();
  }

  addBtn.addEventListener('click', () => openAddMenu(addBtn));

  // 图包内媒体排序：名称 / 时间 / 大小 / 类型 + 升降序（只影响显示顺序，不动磁盘文件）
  // 漫画没有这个控件：页序 = page_no，被「按大小排序」改掉就不是漫画了
  if (isComic) {
    root.querySelector('[data-media-sort]').remove();
    const readBtn = root.querySelector('[data-read]');
    if (readBtn) readBtn.addEventListener('click', () => gotoComic(pack.id, lastPage > 1 ? lastPage : 1));
  } else {
    const mediaSortCtl = createMediaSort({
      key: mediaSortState.key,
      desc: mediaSortState.desc,
      onChange: (key, desc) => {
        setMediaSort(key, desc);
        paintMedia();
      },
    });
    root.querySelector('[data-media-sort]').replaceWith(mediaSortCtl.el);
  }

  root.querySelector('[data-select-toggle]').addEventListener('click', () => {
    if (selecting) exitSelect();
    else enterSelect();
  });

  // 传完自动刷新这一页
  queue.onIdle = () => {
    if (!root.isConnected || !root.querySelector('.page')) return;
    reload();
  };

  bindDropUpload(root.querySelector('.page'), () => ({
    charId: pack.character.id,
    charName: pack.character.name,
    packId: pack.id,
    packTitle: pack.title,
    category: pack.category || null,
  }));

  // 空白处右键
  root.querySelector('.page').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return;
    openContextMenu(e, [
      ...(isComic
        ? [{ label: '阅读', hint: `${items.filter((m) => m.kind === 'image').length} 页`, onClick: () => gotoComic(pack.id, lastPage > 1 ? lastPage : 1) }]
        : []),
      { label: '添加素材', hint: '4 种来源', children: addMediaItems() },
      { label: '编辑图包', onClick: () => root.querySelector('[data-rename]').click() },
      { label: '编辑标签', onClick: editTags },
      { label: '打开本地文件夹', onClick: () => api.reveal('pack', pack.id).catch(() => toast('目录已丢失')) },
      ...(canComic
        ? [
            { separator: true },
            // 图包 ⇄ 漫画：只改类型和页序，文件、封面、标签都不动
            isComic
              ? { label: '转回普通图包', onClick: () => convertKind('pack') }
              : { label: '转为漫画包', hint: '按文件名排页序', onClick: () => convertKind('comic') },
          ]
        : []),
    ]);
  });

  root.querySelector('[data-rename]').addEventListener('click', async () => {
    const v = await openModal({
      title: '编辑图包',
      fields: emoji
        ? [{ name: 'title', label: '名称', value: pack.title, required: true }]
        : [
            { name: 'title', label: '名称', value: pack.title, required: true },
            {
              name: 'month',
              label: '拍摄日期（可选）',
              type: 'month',
              value: pack.month || '',
              hint: '留空则显示创建日期',
            },
          ],
      submitText: '保存',
    });
    if (!v) return;
    try {
      const saved = await api.updatePack(
        id,
        emoji ? { title: v.title } : { title: v.title, month: v.month || null }
      );
      pack.title = saved.title;
      pack.month = saved.month;
      pack.createdAt = saved.createdAt;
      titleEl.textContent = saved.title;
      dateEl.textContent = packDateLabel(pack);
      document.title = `${saved.title} · 资料库`;
      toast('已保存');
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });

  async function editTags() {
    const { openTagPicker } = await import('../components/tag-picker.js');
    const next = await openTagPicker({ title: '编辑图包标签', selected: pack.tags || [], splitTitle: true });
    if (!next) return;
    await api.updatePack(pack.id, { tags: next });
    pack.tags = next;
    paintPackTags();
    toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
  }

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
      gotoMedia([...picked][0]);
    }
  };
  document.addEventListener('keydown', onPageKey);

  paintMedia();
  paintPackTags();
  document.title = `${pack.title} · 资料库`;

  return () => document.removeEventListener('keydown', onPageKey);
}
