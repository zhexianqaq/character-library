import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast, charDeleteMessage } from '../util.js';
import { topbarHtml, bindTopbar, bindTopbarSearch } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openContextMenu } from '../components/context-menu.js';
import { createDropdown } from '../components/dropdown.js';
import { EmojiView } from './emoji.js';
import { ResourcesView } from './resources.js';
import { NovelView } from './novel.js';
import { InboxView } from './inbox.js';

/**
 * 没有条目层级的库。
 *
 * 以前点这些标签会跳到 /e/:id、/rs/:id、/n/:id、/x/:id 四个二级页面 ——
 * 明明和其他库并排放在同一排标签里，点一下却整页换掉、还多出一个「返回」按钮。
 * 现在它们和人物库 / 角色库一样：顶栏和库切换条留在原地，只有内容换。
 * 四个视图都支持 embedded 参数，嵌入时只输出主体，不重复画顶栏。
 */
const FLAT_VIEW = {
  emoji: EmojiView,
  // 散图库和表情库共用一套扁平视图（容器条目挂图包），只是少「未分类」和动图筛选
  loose: EmojiView,
  resource: ResourcesView,
  novel: NovelView,
  inbox: InboxView,
};

/** 卡片排序：默认按素材数量（卡片右上角那个数）从多到少 */
const CARD_SORTS = [
  { value: 'media', label: '素材数量' },
  { value: 'packs', label: '图包数量' },
  { value: 'recent', label: '最新添加' },
  { value: 'name', label: '名称' },
];

/** 库标签条：普通库与嵌入库共用同一份 */
function tabsHtml(shelves, currentId) {
  const items = shelves
    .map((s) => {
      const n =
        s.kind === 'emoji' || s.kind === 'loose'
          ? s.packCount
          : s.kind === 'inbox'
            ? s.mediaCount
            : s.characterCount;
      return `<button data-shelf="${s.id}" class="${s.id === currentId ? 'on' : ''}">${esc(s.name)}<i>${n}</i></button>`;
    })
    .join('');
  return `${items}<button class="seg-add" data-new-shelf title="新建库">＋</button>`;
}

export async function LibraryView(root, shelfId) {
  const state = { q: '', shelfId: Number(shelfId) || null, sort: 'media', embedQ: '' };
  // 列表数据放在视图层：搜索时只重画列表，不重建顶栏 —— 顶栏一重建，输入框就失焦了
  let chars = { items: [], total: 0 };
  let activeShelf = null;
  let noun = '人物';

  function paintCount() {
    const el = root.querySelector('[data-count]');
    if (!el) return;
    el.textContent = `${chars.total} 个角色 · ${fmtNum(activeShelf ? activeShelf.mediaCount : 0)} 个媒体 · ${fmtBytes(
      activeShelf ? activeShelf.bytes || 0 : 0
    )}`;
  }

  function paintGrid() {
    const grid = root.querySelector('[data-grid]');
    if (!grid) return;
    if (!chars.items.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <b>${state.q ? '没有匹配的条目' : '这个库还是空的'}</b>
        ${state.q ? '换个关键词试试' : `点右上角「新建${noun}」开始，建好之后可以把图片和视频传进去`}
      </div>`;
      return;
    }
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
              <div class="sub">${(() => {
                const first = Array.isArray(c.platforms) && c.platforms.length ? c.platforms[0] : null;
                const tag = first ? first.handle || first.platform : '';
                return `${c.packCount} 个图包${tag ? ' · ' + esc(tag) : ''}`;
              })()}</div>
            </div>
          </a>`;
      })
      .join('');
    grid.querySelectorAll('img').forEach(fadeIn);
  }

  /** 搜索 / 换排序都只重画列表区，不动顶栏和工具栏（否则输入框和下拉会重建） */
  async function refreshList() {
    if (!state.shelfId) return;
    chars = await api.shelfCharacters(state.shelfId, { q: state.q.trim(), sort: state.sort });
    if (!root.isConnected) return;
    paintCount();
    paintGrid();
  }

  /** 标签点击：换库不换页 —— 普通库和 flat 库走的都是这一条 */
  function onTabClick(e) {
    const tab = e.target.closest('button[data-shelf]');
    if (!tab) return;
    state.shelfId = Number(tab.dataset.shelf);
    // 换库就换上下文：上一个库的搜索词留着只会让人「怎么什么都没有」
    state.q = '';
    state.embedQ = '';
    render({ push: true });
  }

  /** 新建库：两种骨架共用一份弹窗 */
  async function openNewShelf() {
    const v = await openModal({
      title: '新建库',
      description:
        '人物库 / 角色库按「条目 → 图包 → 素材」组织；散图库 / 表情库没有条目，只有「图包 + 全部素材」；小说库按「归类文件夹 → 书 → 分卷」组织；全部库是收件箱 + 全库总览。',
      fields: [
        { name: 'name', label: '名称', required: true, placeholder: '比如：人物库、原创库' },
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          options: [
            { value: 'people', label: '人物库 · 真人，填平台账号' },
            { value: 'work', label: '角色库 · 虚拟角色，标出处' },
            { value: 'novel:original', label: '原创库 · 小说，按「小说类型」分文件夹' },
            { value: 'novel:fanfic', label: '同人库 · 同人小说，按「原作品名」分文件夹' },
            { value: 'loose', label: '散图库 · 没有条目，只有图包和全部素材（散图 / 杂图）' },
            { value: 'emoji', label: '表情库 · 没有条目，直接放图包（gif / 表情包）' },
            { value: 'resource', label: '资源库 · 游戏 / 动画 / 电影 / 剧集，按标签串起角色' },
            { value: 'inbox', label: '全部库 · 收一堆杂图，再分发给人物 / 角色库' },
          ],
          value: 'people',
          hint: '建好之后也能改，只影响条目那一栏的字段。',
        },
      ],
      submitText: '创建',
    });
    if (!v) return;
    try {
      // 「原创库 / 同人库」共用一个 kind=novel，靠 variant 区分
      const [kind, variant] = String(v.kind).split(':');
      const created = await api.createShelf(v.name, kind, variant ? { variant } : {});
      toast('库已创建');
      // 建完就打开它：flat 库也留在首页，不再跳二级页面
      state.shelfId = created.id;
      render({ push: true });
    } catch (err) {
      toast(err.message || '创建失败');
    }
  }

  /** 通用「编辑库」：只改名称，四个扁平库共用 */
  async function editShelf(shelf) {
    const v = await openModal({
      title: '编辑库',
      fields: [{ name: 'name', label: '库名称', value: shelf.name, required: true }],
      submitText: '保存',
    });
    if (!v) return;
    try {
      await api.patch(`/api/shelves/${shelf.id}`, { name: v.name });
      toast('已保存');
      render();
    } catch (err) {
      toast(err.message || '保存失败');
    }
  }

  /**
   * 嵌入渲染：顶栏 + 库切换条 + 该库自己的整块内容。
   *
   * 子视图（emoji / resources / novel / inbox）传 embedded 后不再画自己的顶栏，
   * 也不会把「返回」绑到它们内部的元素上 —— 这里由 LibraryView 统一提供。
   */
  /**
   * 同步文件夹：把磁盘上的图包目录改成数据库里的名字（单向：库 → 磁盘）。
   *
   * 先预览（只算不动），真有差异才弹确认，再真跑。**整个流程不删任何文件**，
   * 重名的文件自动加后缀，只有空出来的目录才会被回收。
   */
  async function syncFolders(btn) {
    const label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '检查中…';
    }
    try {
      const p = await api.syncPreview();
      const rename = p.packs.renamed || 0;
      const merge = p.packs.merged || 0;
      const loose = p.loose.items || 0;
      const files = (p.filesMoved || 0) + (p.loose.filesMoved || 0);
      if (!rename && !merge && !loose) {
        toast('磁盘已经是同步的');
        return;
      }
      const ok = await openModal({
        title: '同步文件夹？',
        description:
          `按数据库里的图包名整理磁盘：\n` +
          `· 改名 ${rename} 个图包目录\n` +
          `· 合并 ${merge} 个散开的图包（文件搬到一起）\n` +
          `· ${loose} 个「未归包」素材收进「未分类」\n` +
          `共移动 ${files} 个文件。\n` +
          `不会删除任何文件；重名自动加后缀，空出来的目录才会清掉。`,
        submitText: '开始同步',
      });
      if (!ok) return;
      if (btn) btn.textContent = '同步中…';
      const r = await api.syncRun();
      const moved = (r.filesMoved || 0) + (r.loose.filesMoved || 0);
      const bad = (r.errors || []).length;
      toast(
        `同步完成：改名 ${r.packs.renamed} · 合并 ${r.packs.merged} · 移动 ${moved} 个文件` +
          (bad ? ` · ${bad} 个失败` : '')
      );
      await render();
    } catch (err) {
      toast(err.message || '同步失败');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  async function renderEmbedded(active, shelves, ov) {
    // 顶栏是这一层画的，所以嵌入视图的搜索也得挂在这儿：
    // 目前只有资源库有搜索（表情 / 散图 / 小说 / 全部库先按原样）
    const searchable = active.kind === 'resource';
    root.innerHTML =
      topbarHtml({
        title: ov.library.name,
        sub: active.name,
        search: searchable,
        placeholder: '搜索资源名称 / 标签',
        searchValue: state.embedQ,
        actions: `<button class="tb-btn" data-sync-packs title="把磁盘上的图包目录改成数据库里的名字">同步文件夹</button>
          <button class="tb-btn" data-edit-shelf>编辑库</button>`,
      }) +
      `<div class="lib-bar"><div class="segmented" data-tabs>${tabsHtml(shelves, active.id)}</div></div>
       <div data-embed></div>`;

    bindTopbar(root);
    root.querySelector('[data-tabs]').addEventListener('click', onTabClick);
    root.querySelector('[data-new-shelf]').addEventListener('click', openNewShelf);
    root.querySelector('[data-edit-shelf]').addEventListener('click', () => editShelf(active));
    root.querySelector('[data-sync-packs]').addEventListener('click', (e) => syncFolders(e.currentTarget));

    const embed = root.querySelector('[data-embed]');
    if (searchable) {
      bindTopbarSearch(root, (q) => {
        state.embedQ = q;
        // 视图自己知道怎么过滤（资源：名称 / 分类 / 别名 / 标签）
        embed.dispatchEvent(new CustomEvent('cl-search', { detail: { q } }));
      });
    }

    // 总览已经拿过了，顺手传给嵌入视图：全部库的「库总览」不用再请求一遍
    await FLAT_VIEW[active.kind](embed, active.id, {
      embedded: true,
      overview: ov,
      q: state.embedQ,
    });
  }

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
    // 表情库 / 资源库 / 小说库 / 全部库：不跳页，就在首页原地展开
    if (active && FLAT_VIEW[active.kind]) {
      await renderEmbedded(active, shelves, ov);
      return;
    }    const isWork = active ? active.kind === 'work' : false;
    const isNovel = active ? active.kind === 'novel' : false;
    noun = isNovel ? '小说' : isWork ? '角色' : '人物';
    activeShelf = active || null;
    chars = state.shelfId
      ? await api.shelfCharacters(state.shelfId, { q: state.q, sort: state.sort })
      : { items: [], total: 0 };

    root.innerHTML =
      topbarHtml({
        title: ov.library.name,
        sub: active ? active.name : '资料库',
        placeholder: '搜索名称 / 别名 / 标签',
        search: true,
        searchValue: state.q,
        actions: `<button class="tb-btn" data-sync-packs title="把磁盘上的图包目录改成数据库里的名字">同步文件夹</button>
          <button class="tb-btn primary" data-new-char>＋ 新建${noun}</button>`,
      }) +
      `<main class="page">
         <div class="toolbar">
           <div class="segmented" data-tabs>${tabsHtml(shelves, state.shelfId)}</div>
           <span class="spacer"></span>
           <span class="count" data-count>${chars.total} 个角色 · ${fmtNum(active ? active.mediaCount : 0)} 个媒体 · ${fmtBytes(
             active ? active.bytes || 0 : 0
           )}</span>
           <span data-sort></span>
         </div>
         <div class="char-grid" data-grid></div>
       </main>`;

    bindTopbar(root);
    root.querySelector('[data-sync-packs]').addEventListener('click', (e) => syncFolders(e.currentTarget));

    // 排序切换（紧贴计数右边）
    const sortDD = createDropdown({
      options: CARD_SORTS,
      value: state.sort,
      allowEmpty: false,
      className: 'sort-dd',
      onChange: async (v) => {
        state.sort = v;
        try {
          await refreshList();
        } catch {
          toast('排序失败');
        }
      },
    });
    root.querySelector('[data-sort]').replaceWith(sortDD.el);
    paintGrid();

    const grid = root.querySelector('[data-grid]');

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
      const res = await api.deleteCharacter(item.id);
      toast(charDeleteMessage(res));
      render();
    }

    // 角色库切换
    root.querySelector('[data-tabs]').addEventListener('click', onTabClick);
    root.querySelector('[data-new-shelf]').addEventListener('click', openNewShelf);

    // 新建角色
    root.querySelector('[data-new-char]').addEventListener('click', async () => {
      if (!state.shelfId) return toast('先建一个角色库');
      const v = await openModal({
        title: `新建${noun}`,
        description: `建好后可以在${noun}页面上传图片和视频，出处 / 平台在详情页右侧填。`,
        fields: [
          {
            name: 'name',
            label: `${noun}名`,
            required: true,
            placeholder: isWork ? '比如：申鹤，雷电将军' : '比如：水淼，纸悦',
            hint: '要一次建多个，用逗号隔开（中英文逗号都行）',
          },
          { name: 'intro', label: '简介', type: 'textarea', placeholder: '选填，之后也能改' },
        ],
        submitText: '创建',
      });
      if (!v) return;

      // 中英文逗号 / 顿号 / 分号都能当分隔符
      const names = String(v.name || '')
        .split(/[,，、;；\n]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 80);
      if (!names.length) {
        toast('名字不能为空');
        return;
      }

      try {
        if (names.length === 1) {
          const c = await api.createCharacter({ shelfId: state.shelfId, name: names[0], intro: v.intro });
          // 磁盘上已有同名目录时会自动加 -2 后缀，别让用户以为目录建错了地方
          toast(
            c.dirRenamed
              ? `${noun}已创建；本地已有同名目录，用了「${String(c.dirSlug || '').split('/').pop()}」`
              : `${noun}已创建，去上传素材吧`
          );
          history.pushState({}, '', `/c/${c.id}`);
          window.dispatchEvent(new CustomEvent('app:route'));
          return;
        }

        // 批量建的时候先把目标库定下来：循环里每轮都读 state.shelfId 的话，
        // 中途切一次库（tab 点击）剩下的条目就会被丢进另一个库里
        const targetShelf = state.shelfId;
        const failed = [];
        for (const name of names) {
          try {
            await api.createCharacter({ shelfId: targetShelf, name, intro: v.intro });
          } catch {
            failed.push(name);
          }
        }
        const okCount = names.length - failed.length;
        toast(
          failed.length
            ? `已创建 ${okCount} 个，失败 ${failed.length} 个（${failed.slice(0, 3).join('、')}）`
            : `已创建 ${okCount} 个${noun}`
        );
        await render();
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    // 搜索：只重画列表和计数，顶栏保持不动。
    // 以前这里是整页 render()，顶栏跟着重建 → 输入框被换掉、焦点丢失，只能打进去两三个字母。
    bindTopbarSearch(root, async (q) => {
      state.q = q;
      try {
        await refreshList();
      } catch {
        /* 搜索失败就保持上一次结果 */
      }
    });
  }

  await render();
}
