import { api } from '../api.js';
import { esc, fmtNum, fadeIn, toast, copyText, charDeleteMessage, splitAliases } from '../util.js';
import { topbarHtml, bindTopbar, bindTopbarSearch } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { offerExistingEntry } from '../dup-entry.js';
import { openContextMenu } from '../components/context-menu.js';
import { openTagPicker } from '../components/tag-picker.js';
import { createDropdown } from '../components/dropdown.js';

/** 资源分类：游戏 / 动画 / 电影 / 剧集（可自由加） */
export const RES_CATS = ['游戏', '动画', '电影', '剧集'];

/** 名称 + 分类 + 简介 + 标签，新建和编辑共用 */
async function editResourceModal(item = null) {
  const v = await openModal({
    title: item ? '编辑资源' : '新建资源',
    description: item
      ? '改了名称后，角色 / 人物上的同名标签记得一起改。'
      : '建好之后，给角色或人物打上同名标签（或在出处里写上这个名称），它们就会自动出现在这里。',
    fields: [
      { name: 'name', label: '名称', required: true, value: item ? item.name : '', placeholder: '比如：原神', hint: item ? '' : '要一次建多个，用逗号隔开（中英文逗号都行）' },
      {
        name: 'category',
        label: '分类',
        type: 'select',
        options: RES_CATS.map((c) => ({ value: c, label: c })),
        value: item ? item.category || RES_CATS[0] : RES_CATS[0],
        required: true,
      },
      {
        name: 'aliases',
        label: '别名',
        value: item ? (item.aliases || []).join('、') : '',
        placeholder: '简称、原名、日文名、英文名，用顿号或逗号隔开',
        hint: '游戏 / 动画 / 电影 / 剧集都支持；详情页里也能直接改',
      },
      { name: 'intro', label: '简介', type: 'textarea', value: item ? item.intro || '' : '', placeholder: '选填' },
      {
        name: 'tags',
        label: '标签',
        value: item ? (item.tags || []).join('、') : '',
        placeholder: '用顿号或逗号分隔，比如：米哈游、开放世界',
        hint: '标签是跳转的关键：角色 / 人物上打同样的标签，就会挂到这个资源下。',
      },
    ],
    submitText: item ? '保存' : '创建',
  });
  if (!v) return null;
  const tags = String(v.tags || '')
    .split(/[、,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return { name: v.name.trim(), category: v.category, intro: v.intro || '', tags, aliases: splitAliases(v.aliases) };
}

export async function ResourcesView(root, shelfId, opts = {}) {
  /* 嵌入首页时不自带顶栏：顶栏和库切换条由 LibraryView 提供 */
  const embedded = !!opts.embedded;
  let data = await api.resources(shelfId);
  let shelf = data.shelf;
  let items = data.items;
  let groups = data.groups;
  let cat = '';
  // 顶栏搜索词：名称 / 别名 / 分类 / 简介 / 标签都能命中
  let q = String(opts.q || '');
  // 卡片排序：默认按关联数量（卡片副标题里那个「N 个条目」）从多到少
  let sort = 'linked';

  const CARD_SORTS = [
    { value: 'linked', label: '关联数量' },
    { value: 'name', label: '名称' },
    { value: 'category', label: '分类' },
  ];

  /** 分类筛选 + 关键词 + 排序后的列表（不动 items 本身） */
  function visibleItems() {
    let list = cat ? items.filter((x) => (x.category || '') === cat) : items.slice();
    const kw = q.trim().toLowerCase();
    if (kw) {
      list = list.filter((x) => {
        const hay = [x.name, x.category, x.intro, ...(x.aliases || []), ...(x.tags || [])];
        return hay.some((s) => String(s || '').toLowerCase().includes(kw));
      });
    }
    if (sort === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    } else if (sort === 'category') {
      list.sort(
        (a, b) =>
          String(a.category || '').localeCompare(String(b.category || ''), 'zh') ||
          (b.linked || 0) - (a.linked || 0) ||
          a.name.localeCompare(b.name, 'zh-Hans-CN')
      );
    } else {
      list.sort((a, b) => (b.linked || 0) - (a.linked || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }
    return list;
  }

  function counts() {
    const map = Object.fromEntries(groups.map((g) => [g.name, g.count]));
    return { '': items.length, ...map };
  }

  function paintShell() {
    const n = counts();
    const cats = RES_CATS.slice();
    for (const g of groups) if (!cats.includes(g.name)) cats.push(g.name);
    root.innerHTML =
      (embedded
        ? ''
        : topbarHtml({
            back: true,
            title: shelf.name,
            sub: '',
            search: true,
            placeholder: '搜索资源名称 / 别名 / 标签',
            searchValue: q,
            actions: `<button class="tb-btn" data-edit-shelf>编辑库</button>`,
          })) +
      `<main class="page">
         <div class="shelf-head">
           <div class="sh-main">
             <h1 class="sh-title">${esc(shelf.name)}</h1>
             <div class="sh-meta" data-meta></div>
           </div>
           <span class="spacer"></span>
           <button class="tb-btn primary" data-new-res>＋ 资源</button>
         </div>
         <div class="toolbar">
           <div class="segmented" data-cat>
             <button class="${cat === '' ? 'on' : ''}" data-c="">全部<i>${n[''] || 0}</i></button>
             ${cats
               .map(
                 (c) =>
                   `<button class="${cat === c ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}<i>${n[c] || 0}</i></button>`
               )
               .join('')}
           </div>
           <span class="spacer"></span>
           <span class="count" data-count></span>
           <span data-sort></span>
         </div>
         <div class="char-grid" data-grid></div>
       </main>`;

    if (!embedded) bindTopbar(root);

    if (!embedded) bindTopbarSearch(root, applySearch);

    const sortDD = createDropdown({
      options: CARD_SORTS,
      value: sort,
      allowEmpty: false,
      className: 'sort-dd',
      onChange: (v) => {
        sort = v;
        paintGrid();
      },
    });
    root.querySelector('[data-sort]').replaceWith(sortDD.el);
    paintMeta();
    paintGrid();

    root.querySelector('[data-cat]').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-c]');
      if (!btn) return;
      cat = btn.dataset.c;
      root.querySelectorAll('[data-cat] button').forEach((b) => b.classList.toggle('on', b === btn));
      paintGrid();
    });

    root.querySelector('[data-new-res]').addEventListener('click', async () => {
      const v = await editResourceModal();
      if (!v) return;
      // 和人物 / 角色一样支持逗号批量：中英文逗号、顿号、分号、换行都算分隔符
      const names = String(v.name || '')
        .split(/[,，、;；\n]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 80);
      if (!names.length) return toast('名称不能为空');

      // 已存在的同名资源直接跳过，别建出两张「原神」把关联搞乱
      const exist = new Set(items.map((x) => x.name));
      const todo = [];
      const skipped = [];
      for (const name of names) {
        if (exist.has(name)) {
          skipped.push(name);
          continue;
        }
        exist.add(name);
        todo.push(name);
      }
      if (!todo.length) {
        toast(`这些资源都已经有了：${skipped.slice(0, 3).join('、')}`);
        const hit = skipped.length === 1 ? items.find((x) => x.name === skipped[0]) : null;
        if (hit) await offerExistingEntry(hit.name, hit.id);
        return;
      }

      try {
        const failed = [];
        const dups = [];
        for (const name of todo) {
          try {
            await api.createCharacter({ shelfId, ...v, name });
          } catch (err) {
            if (err.status === 409 && err.body && err.body.id) dups.push({ name: err.body.name || name, id: err.body.id });
            else failed.push(name);
          }
        }
        const ok = todo.length - failed.length - dups.length;
        const parts = [];
        if (ok) parts.push(todo.length === 1 && !failed.length ? `「${todo[0]}」已创建` : `已创建 ${ok} 个资源`);
        if (skipped.length) parts.push(`跳过 ${skipped.length} 个已存在`);
        if (dups.length) parts.push(`这个库里已经有 ${dups.length} 个同名`);
        if (failed.length) parts.push(`失败 ${failed.length} 个（${failed.slice(0, 3).join('、')}）`);
        toast(parts.join(' · ') || '创建失败');
        if (dups.length === 1) await offerExistingEntry(dups[0].name, dups[0].id);
        await reload();
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    // 嵌入首页时没有这颗按钮（由 LibraryView 统一提供），绑定必须可选
    root.querySelector('[data-edit-shelf]')?.addEventListener('click', async () => {
      const v = await openModal({
        title: '编辑库',
        fields: [{ name: 'name', label: '库名称', value: shelf.name, required: true }],
        submitText: '保存',
      });
      if (!v) return;
      try {
        await api.patch(`/api/shelves/${shelfId}`, { name: v.name });
        shelf.name = v.name;
        paintShell();
        toast('已保存');
      } catch (err) {
        toast(err.message || '保存失败');
      }
    });

    bindContextMenus();
  }

  /** 打开资源详情 */
  function gotoResource(resId) {
    history.pushState({ from: location.pathname + location.search }, '', `/r/${resId}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  async function copyName(item) {
    const ok = await copyText(item.name);
    toast(ok ? `已复制「${item.name}」` : '复制失败，请手动选中文字');
  }

  /** 资源标签 = 卡片自己的标签 + 资源名（名字本身就是一个标签） */
  async function editTags(item) {
    const next = await openTagPicker({ title: `「${item.name}」的标签`, selected: item.tags || [] });
    if (!next) return;
    const tags = [...new Set([...next, item.name])];
    try {
      await api.updateCharacter(item.id, { tags });
      toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
      await reload();
    } catch (err) {
      toast(err.message || '保存失败');
    }
  }

  function cardMenu(item) {
    return [
      { label: '打开', onClick: () => gotoResource(item.id) },
      { label: '编辑资源', onClick: () => editOne(item) },
      { label: '编辑标签', hint: '关联靠标签', onClick: () => editTags(item) },
      { label: '复制名称', hint: '给条目打标签用', onClick: () => copyName(item) },
      { label: '打开本地文件夹', onClick: () => api.reveal('character', item.id).catch(() => toast('目录已丢失')) },
      { separator: true },
      { label: '删除', danger: true, hint: '只删卡片', onClick: () => removeOne(item) },
    ];
  }

  function blankMenu() {
    const n = counts();
    const cats = ['', ...RES_CATS.filter((c) => n[c]), ...groups.map((g) => g.name).filter((g) => !RES_CATS.includes(g))];
    return [
      { label: '新建资源', onClick: () => root.querySelector('[data-new-res]').click() },
      {
        label: '只看分类',
        hint: cat || '全部',
        children: [...new Set(cats)].map((c) => ({
          label: `${c || '全部'}${n[c] ? `（${n[c]}）` : ''}`,
          hint: cat === c ? '当前' : '',
          onClick: () => {
            cat = c;
            root.querySelectorAll('[data-cat] button').forEach((b) => b.classList.toggle('on', b.dataset.c === c));
            paintGrid();
          },
        })),
      },
      { separator: true },
      ...(root.querySelector('[data-edit-shelf]')
        ? [{ label: '编辑库', onClick: () => root.querySelector('[data-edit-shelf]').click() }]
        : []),
      { label: '刷新列表', onClick: () => reload() },
    ];
  }

  function bindContextMenus() {
    const page = root.querySelector('.page');
    if (!page) return;
    page.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.res-card');
      if (card) {
        const item = items.find((x) => x.id === Number(card.dataset.id));
        if (item) {
          openContextMenu(e, cardMenu(item));
          return;
        }
      }
      openContextMenu(e, blankMenu());
    });
  }

  function paintMeta() {
    const parts = [`${fmtNum(items.length)} 个资源`];
    for (const g of groups) parts.push(`${g.name} ${g.count}`);
    root.querySelector('[data-meta]').textContent = parts.join(' · ');
  }

  function paintGrid() {
    const grid = root.querySelector('[data-grid]');
    const list = visibleItems();
    const kw = q.trim();
    // 搜索时把命中数显示出来，光看空列表不知道是没搜到还是库是空的
    root.querySelector('[data-count]').textContent = kw
      ? `${list.length} / ${items.length}`
      : list.length === items.length
        ? ''
        : `${list.length} 个`;
    if (!list.length) {
      grid.innerHTML = kw
        ? `<div class="empty" style="grid-column:1/-1">
             <b>没有匹配「${esc(kw)}」的资源</b>名称、别名、分类、简介和标签都会参与匹配，换个关键词试试
           </div>`
        : `<div class="empty" style="grid-column:1/-1">
             <b>${items.length ? '这个分类下还没有资源' : '还没有资源'}</b>
             ${
               items.length
                 ? '换个分类看看'
                 : '点右上角「＋ 资源」建一个，比如「原神」，再给角色 / 人物打上同名标签'
             }
           </div>`;
      return;
    }
    grid.innerHTML = list
      .map((it) => {
        const img = it.coverMediaId ? api.thumb(it.coverMediaId) : '';
        const sub = [it.category, it.linked ? `${it.linked} 个条目` : '', (it.tags || []).slice(0, 2).join(' · ')]
          .filter(Boolean)
          .join(' · ');
        return `<a class="char-card res-card" href="/r/${it.id}" data-link data-id="${it.id}">
          <div class="cover">
            ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">待添加</div>'}
            ${it.category ? `<span class="cat-chip">${esc(it.category)}</span>` : ''}
          </div>
          <div class="info">
            <div class="name">${esc(it.name)}</div>
            <div class="sub">${esc(sub || '暂无关联')}</div>
          </div>
        </a>`;
      })
      .join('');
    grid.querySelectorAll('img').forEach(fadeIn);
  }

  /**
   * 顶栏搜索（两处入口共用）：
   * 自带顶栏时来自 bindTopbarSearch，嵌入首页时来自 LibraryView 派发的 cl-search。
   */
  function applySearch(val) {
    q = String(val || '').trim();
    // 搜索是全局的：被分类卡住会让人以为「库里没有」，所以有关键词就回到「全部」
    if (q && cat) {
      cat = '';
      root.querySelectorAll('[data-cat] button').forEach((b) => b.classList.toggle('on', b.dataset.c === ''));
    }
    paintGrid();
  }

  async function reload() {
    data = await api.resources(shelfId);
    shelf = data.shelf;
    items = data.items;
    groups = data.groups;
    paintShell();
  }
  async function editOne(item) {
    const v = await editResourceModal(item);
    if (!v) return;
    try {
      await api.updateCharacter(item.id, {
        name: v.name,
        category: v.category,
        intro: v.intro,
        tags: v.tags,
        aliases: v.aliases,
      });
      toast('已保存');
      await reload();
    } catch (err) {
      if (err.status === 409 && err.body && err.body.id) {
        await offerExistingEntry(err.body.name || v.name, err.body.id);
        return;
      }
      toast(err.message || '保存失败');
    }
  }

  async function removeOne(item) {
    const ok = await confirmDialog(
      '删除这个资源？',
      `只是删掉「${item.name}」这张卡片，角色 / 人物和它们的媒体不会受影响。`
    );
    if (!ok) return;
    try {
      const res = await api.deleteCharacter(item.id);
      toast(charDeleteMessage(res));
      await reload();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  // 嵌入首页时顶栏由 LibraryView 画，搜索词通过 cl-search 事件传进来。
  // 只挂一次：paintShell 会重画内容，但 root 这个容器本身不动。
  if (embedded) {
    root.addEventListener('cl-search', (e) => applySearch(e.detail && e.detail.q));
  }

  paintShell();
  document.title = `${shelf.name} · 资料库`;
}
