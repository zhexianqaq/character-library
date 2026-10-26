import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { openModal } from '../components/modal.js';

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
                   `<button data-shelf="${s.id}" class="${s.id === state.shelfId ? 'on' : ''}">${esc(s.name)}<i>${s.characterCount}</i></button>`
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

    // 角色库切换
    root.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-shelf]');
      if (!tab) return;
      state.shelfId = Number(tab.dataset.shelf);
      render({ push: true });
    });

    root.querySelector('[data-new-shelf]').addEventListener('click', async () => {
      const v = await openModal({
        title: '新建库',
        description: '两种库结构完全一样，区别只在条目上那一栏：真人放社交账号，虚拟角色标出处。',
        fields: [
          { name: 'name', label: '名称', required: true, placeholder: '比如：人物库、角色库' },
          {
            name: 'kind',
            label: '类型',
            type: 'select',
            options: [
              { value: 'people', label: '真人 · 填平台账号（推特 / 微博 / B站…）' },
              { value: 'work', label: '虚拟角色 · 标出处（游戏 / 动画 / 小说…）' },
            ],
            value: 'people',
            hint: '建好之后也能改，只影响条目那一栏的字段。',
          },
        ],
        submitText: '创建',
      });
      if (!v) return;
      try {
        await api.createShelf(v.name, v.kind);
        toast('库已创建');
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
