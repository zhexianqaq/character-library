import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openContextMenu } from '../components/context-menu.js';

/** 没有条目层级的库，直接有自己的页面 */
const FLAT_HOME = { emoji: '/e/', resource: '/rs/' };

export async function LibraryView(root, shelfId) {
  const state = { q: '', shelfId: Number(shelfId) || null, sort: 'recent' };

  async function render({ push = false } = {}) {
    const ov = await api.overview();
    const shelves = ov.shelves;
    if (!state.shelfId || !shelves.some((s) => s.id === state.shelfId)) {
      state.shelfId = shelves[0] ? shelves[0].id : null;
    }
    if (push) {
      const url = state.shelfId && shelves.length > 1 ? `/s/${state.shelfId}` : '/';
      if (url !== location.pathname) history.pushState({}, '', url);
    }

    const active = shelves.find((s) => s.id === state.shelfId);
    // 表情库 / 资源库没有条目层级，直接进自己的页面
    if (active && FLAT_HOME[active.kind]) {
      history.replaceState({}, '', `${FLAT_HOME[active.kind]}${active.id}`);
      root.innerHTML = '';
      // 当前这一轮 renderRoute 还占着 busy，下一帧再切
      setTimeout(() => window.dispatchEvent(new CustomEvent('app:route')), 0);
      return;
    }
    const isWork = active ? active.kind === 'work' : false;
    const noun = isWork ? '角色' : '人物';
    const chars = state.shelfId
      ? await api.shelfCharacters(state.shelfId, { q: state.q, sort: state.sort })
      : { items: [], total: 0 };

    root.innerHTML =
      topbarHtml({
        title: ov.library.name,
        sub: active ? active.name : '资料库',
        placeholder: '搜索名称',
        search: true,
        actions: `<button class="tb-btn primary" data-new-char>＋ 新建${noun}</button>`,
      }) +
      `<main class="page">
         <div class="toolbar">
           <div class="segmented" data-tabs>
             ${shelves
               .map(
                 (s) =>
                   `<button data-shelf="${s.id}" class="${s.id === state.shelfId ? 'on' : ''}">${esc(s.name)}<i>${
                     s.kind === 'emoji' ? s.packCount : s.characterCount
                   }</i></button>`
               )
               .join('')}
             <button class="seg-add" data-new-shelf title="新建库">＋</button>
           </div>
           <span class="spacer"></span>
           <span class="count">${chars.total} 个角色 · ${fmtNum(active ? active.mediaCount : 0)} 个媒体 · ${fmtBytes(
             active ? active.bytes || 0 : 0
           )}</span>
         </div>
         <div class="char-grid" data-grid></div>
       </main>`;

    bindTopbar(root);

    const grid = root.querySelector('[data-grid]');
    if (!chars.items.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <b>${state.q ? '没有匹配的条目' : '这个库还是空的'}</b>
        ${state.q ? '换个关键词试试' : `点右上角「新建${noun}」开始，建好之后可以把图片和视频传进去`}
      </div>`;
    } else {
      grid.innerHTML = chars.items
        .map((c) => {
          const img = c.coverMediaId ? api.thumb(c.coverMediaId) : '';
          return `<a class="char-card" href="/c/${c.id}" data-link>
            <div class="cover">
              ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">待添加</div>'}
              <span class="badge">${fmtNum(c.mediaCount)}</span>
            </div>
            <div class="info">
              <div class="name">${esc(c.name)}</div>
              <div class="sub">${c.packCount} 个图包${c.account ? ' · @' + esc(c.account) : ''}</div>
            </div>
          </a>`;
        })
        .join('');
      grid.querySelectorAll('img').forEach(fadeIn);
    }

    // 右键：卡片 → 条目操作；空白处 → 新建
    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.char-card');
      if (!card) {
        openContextMenu(e, [
          { label: `新建${noun}`, onClick: () => root.querySelector('[data-new-char]').click() },
          { label: '新建库', onClick: () => root.querySelector('[data-new-shelf]').click() },
          { separator: true },
          { label: '刷新', onClick: () => render() },
        ]);
        return;
      }
      e.preventDefault();
      const cid = Number(card.getAttribute('href').split('/').pop());
      const item = chars.items.find((x) => x.id === cid);
      if (!item) return;
      openContextMenu(e, [
        { label: '打开', onClick: () => { history.pushState({}, '', `/c/${cid}`); window.dispatchEvent(new CustomEvent('app:route')); } },
        { label: '编辑名称', onClick: () => renameCharacter(item) },
        { label: `添加素材`, hint: '进入后上传', onClick: () => (location.href = `/c/${cid}?upload=1`) },
        { label: '打开本地文件夹', onClick: () => api.reveal('character', cid).catch(() => toast('目录已丢失')) },
        { separator: true },
        { label: '删除', danger: true, onClick: () => removeCharacter(item) },
      ]);
    });

    async function renameCharacter(item) {
      const v = await openModal({
        title: '编辑名称',
        fields: [{ name: 'name', label: '名称', value: item.name, required: true }],
        submitText: '保存',
      });
      if (!v) return;
      await api.updateCharacter(item.id, { name: v.name });
      toast('已重命名');
      render();
    }

    async function removeCharacter(item) {
      const ok = await confirmDialog(
        '删除这个条目？',
        `「${item.name}」下的 ${item.packCount} 个图包、${item.mediaCount} 个媒体会一并删除，磁盘文件也会删掉。`
      );
      if (!ok) return;
      await api.deleteCharacter(item.id);
      toast('已删除');
      render();
    }

    // 角色库切换
    root.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-shelf]');
      if (!tab) return;
      const nextId = Number(tab.dataset.shelf);
      const nextShelf = shelves.find((s) => s.id === nextId);
      if (nextShelf && FLAT_HOME[nextShelf.kind]) {
        history.pushState({}, '', `${FLAT_HOME[nextShelf.kind]}${nextId}`);
        window.dispatchEvent(new CustomEvent('app:route'));
        return;
      }
      state.shelfId = nextId;
      render({ push: true });
    });

    root.querySelector('[data-new-shelf]').addEventListener('click', async () => {
      const v = await openModal({
        title: '新建库',
        description: '人物库 / 角色库按「条目 → 图包 → 素材」组织；表情库没有条目，库里直接是图包。',
        fields: [
          { name: 'name', label: '名称', required: true, placeholder: '比如：人物库、角色库' },
          {
            name: 'kind',
            label: '类型',
            type: 'select',
            options: [
              { value: 'people', label: '人物库 · 真人，填平台账号' },
              { value: 'work', label: '角色库 · 虚拟角色，标出处' },
              { value: 'emoji', label: '表情库 · 没有条目，直接放图包（gif / 表情包）' },
              { value: 'resource', label: '资源库 · 游戏 / 动画 / 电影 / 剧集，按标签串起角色' },
            ],
            value: 'people',
            hint: '建好之后也能改，只影响条目那一栏的字段。',
          },
        ],
        submitText: '创建',
      });
      if (!v) return;
      try {
        const created = await api.createShelf(v.name, v.kind);
        toast('库已创建');
        if (FLAT_HOME[v.kind]) {
          history.pushState({}, '', `${FLAT_HOME[v.kind]}${created.id}`);
          window.dispatchEvent(new CustomEvent('app:route'));
          return;
        }
        render();
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    // 新建角色
    root.querySelector('[data-new-char]').addEventListener('click', async () => {
      if (!state.shelfId) return toast('先建一个角色库');
      const v = await openModal({
        title: `新建${noun}`,
        description: `建好后可以在${noun}页面上传图片和视频。`,
        fields: [
          { name: 'name', label: `${noun}名`, required: true, placeholder: isWork ? '比如：雷电将军' : '比如：水淼' },
          { name: 'account', label: '账号 / 来源', placeholder: '选填，比如 aqua_cosplay' },
          { name: 'intro', label: '简介', type: 'textarea', placeholder: '选填，之后也能改' },
        ],
        submitText: '创建',
      });
      if (!v) return;
      try {
        const c = await api.createCharacter({ shelfId: state.shelfId, ...v });
        toast(`${noun}已创建，去上传素材吧`);
        history.pushState({}, '', `/c/${c.id}`);
        window.dispatchEvent(new CustomEvent('app:route'));
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    // 搜索
    const input = root.querySelector('.search input');
    if (input) {
      input.value = state.q;
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.q = input.value.trim();
          render();
        }, 240);
      });
    }
  }

  await render();
}
