import { api } from '../api.js';
import { esc, fmtNum, fadeIn, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openContextMenu } from '../components/context-menu.js';

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
      { name: 'name', label: '名称', required: true, value: item ? item.name : '', placeholder: '比如：原神' },
      {
        name: 'category',
        label: '分类',
        type: 'select',
        options: RES_CATS.map((c) => ({ value: c, label: c })),
        value: item ? item.category || RES_CATS[0] : RES_CATS[0],
        required: true,
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
  return { name: v.name.trim(), category: v.category, intro: v.intro || '', tags };
}

export async function ResourcesView(root, shelfId) {
  let data = await api.resources(shelfId);
  let shelf = data.shelf;
  let items = data.items;
  let groups = data.groups;
  let cat = '';

  function counts() {
    const map = Object.fromEntries(groups.map((g) => [g.name, g.count]));
    return { '': items.length, ...map };
  }

  function paintShell() {
    const n = counts();
    const cats = RES_CATS.slice();
    for (const g of groups) if (!cats.includes(g.name)) cats.push(g.name);
    root.innerHTML =
      topbarHtml({
        back: true,
        title: shelf.name,
        sub: '',
        actions: `<button class="tb-btn" data-edit-shelf>编辑库</button>`,
      }) +
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
         </div>
         <div class="char-grid" data-grid></div>
       </main>`;

    bindTopbar(root);
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
      try {
        await api.createCharacter({ shelfId, ...v });
        toast(`「${v.name}」已创建`);
        await reload();
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    root.querySelector('[data-edit-shelf]').addEventListener('click', async () => {
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

    root.querySelector('[data-grid]').addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.res-card');
      if (!card) return;
      const item = items.find((x) => x.id === Number(card.dataset.id));
      if (!item) return;
      openContextMenu(e, [
        {
          label: '打开',
          onClick: () => {
            history.pushState({}, '', `/r/${item.id}`);
            window.dispatchEvent(new CustomEvent('app:route'));
          },
        },
        { label: '编辑', onClick: () => editOne(item) },
        { separator: true },
        { label: '删除', danger: true, onClick: () => removeOne(item) },
      ]);
    });
  }

  function paintMeta() {
    const parts = [`${fmtNum(items.length)} 个资源`];
    for (const g of groups) parts.push(`${g.name} ${g.count}`);
    root.querySelector('[data-meta]').textContent = parts.join(' · ');
  }

  function paintGrid() {
    const grid = root.querySelector('[data-grid]');
    const list = cat ? items.filter((x) => (x.category || '') === cat) : items;
    root.querySelector('[data-count]').textContent = list.length === items.length ? '' : `${list.length} 个`;
    if (!list.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
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
      await api.updateCharacter(item.id, { name: v.name, category: v.category, intro: v.intro, tags: v.tags });
      toast('已保存');
      await reload();
    } catch (err) {
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
      await api.deleteCharacter(item.id);
      toast('已删除');
      await reload();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  paintShell();
  document.title = `${shelf.name} · 资料库`;
}
