import { api } from '../api.js';
import { esc, fmtNum, fadeIn, toast, charDeleteMessage } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openContextMenu } from '../components/context-menu.js';
import { createDropdown } from '../components/dropdown.js';
import { ORIGIN_TYPES, novelFieldSet } from '../novel-fields.js';

/**
 * 小说库首页。
 *
 * 两个维度是正交的，界面上也别混在一起：
 *   顶部 tab   = 分类视图（出版/网络 或 短篇/长篇），只筛选
 *   分组标题   = 归类文件夹（小说类型 或 原作品名），等于磁盘上的一层目录
 *
 * 所以切 tab 不会改变书的归属，只改变「这一页显示哪些书」。
 */

/** 原创库的常用类型；datalist 可手输，没列出来的照样能用 */

const SORTS = [
  { value: 'words', label: '字数' },
  { value: 'media', label: '素材数量' },
  { value: 'name', label: '书名' },
  { value: 'recent', label: '最新添加' },
];

/** 分组标题上的小文件夹图标——提醒这层是真实目录，不是纯标签 */
const FOLDER_ICON = `<svg class="ng-ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.8 4.2h4l1.4 1.8h7v5.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/></svg>`;

function wordsLabel(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v >= 10000) {
    const w = v / 10000;
    return `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10} 万字`;
  }
  return `${fmtNum(v)} 字`;
}

export async function NovelView(root, shelfId, opts = {}) {
  /* 嵌入首页时不自带顶栏：顶栏和库切换条由 LibraryView 提供 */
  const embedded = !!opts.embedded;
  const id = Number(shelfId);
  let data = await api.novelShelf(id);
  let shelf = data.shelf;
  let items = data.items;
  /** 袋子（packs.kind='novel'）：库里按类型 / 原作分的书架 */
  let bags = [];
  try {
    bags = (await api.novelBags(id)).items || [];
  } catch {
    bags = [];
  }
  // bag 为空 = 袋子列表；有值 = 打开的那个袋子（按 novel_group 对应）
  const state = { view: '', bag: '', q: '', sort: 'words' };
  // 同人库：原作品名 → 资源库作品卡 id，用来在分组标题上给一个直达入口
  let workMap = new Map();

  const isFan = () => shelf.variant === 'fanfic';

  async function loadWorks() {
    try {
      const idx = await api.resourceIndex();
      workMap = new Map((idx.items || []).map((x) => [x.name, x.id]));
    } catch {
      workMap = new Map();
    }
  }

  /** 本库已有的归类文件夹（按书数降序） */
  function knownGroups() {
    const m = new Map();
    for (const it of items) {
      const g = it.novelGroup || '';
      if (g) m.set(g, (m.get(g) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  }

  /** 同人库的原作品建议值：已有分组 + 资源库的作品名（这样「原神」两边写法能对齐） */
  async function fanficGroups() {
    const own = knownGroups();
    let works = [];
    try {
      const idx = await api.resourceIndex();
      works = (idx.items || []).map((x) => x.name);
    } catch {
      works = [];
    }
    return [...new Set([...own, ...works])].slice(0, 200);
  }

  function visibleItems() {
    let list = items.filter((x) => !state.view || x.novelSubtype === state.view);
    if (state.bag) list = list.filter((x) => (x.novelGroup || '') === state.bag);
    const q = state.q.trim().toLowerCase();
    if (q) {
      list = list.filter((x) => `${x.name} ${x.author || ''} ${x.novelGroup || ''}`.toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      if (state.sort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
      if (state.sort === 'recent') return String(b.id).localeCompare(String(a.id));
      if (state.sort === 'media') return (b.mediaCount || 0) - (a.mediaCount || 0) || b.id - a.id;
      return (b.wordCount || 0) - (a.wordCount || 0) || b.id - a.id;
    });
    return list;
  }

  /** 按归类文件夹分桶；组按书数降序，和磁盘上文件夹的「轻重」一致 */
  function buckets(list) {
    const map = new Map();
    for (const it of list) {
      const g = it.novelGroup || '未归类';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(it);
    }
    return [...map.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN')
    );
  }

  function card(it) {
    const img = it.coverMediaId ? api.thumb(it.coverMediaId) : '';
    const sub = [it.author, wordsLabel(it.wordCount), it.novelStatus].filter(Boolean).join(' · ');
    return `<a class="char-card novel-card" href="/c/${it.id}" data-link data-id="${it.id}">
      <div class="cover">
        <div class="cover-title"><span>${esc(it.name)}</span></div>
        ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        ${it.novelSubtype ? `<span class="sub-chip">${esc(it.novelSubtype)}</span>` : ''}
        ${it.mediaCount ? `<span class="badge">${fmtNum(it.mediaCount)}</span>` : ''}
      </div>
      <div class="info">
        <div class="name">${esc(it.name)}</div>
        <div class="sub">${esc(sub || '还没有作者信息')}</div>
      </div>
    </a>`;
  }

  function paintMeta() {
    const words = items.reduce((a, x) => a + (x.wordCount || 0), 0);
    const parts = [`${fmtNum(bags.length)} 个袋子`, `${fmtNum(items.length)} 本`];
    if (words) parts.push(wordsLabel(words));
    if (state.bag) parts.unshift(state.bag);
    root.querySelector('[data-meta]').textContent = parts.join(' · ');
  }

  function paintTabs() {
    const box = root.querySelector('[data-view]');
    if (!box) return;
    box.innerHTML = data.views
      .map(
        (v) =>
          `<button class="${state.view === v.value ? 'on' : ''}" data-v="${esc(v.value)}">${esc(
            v.label
          )}<i>${v.count}</i></button>`
      )
      .join('');
  }

  /** 袋子卡片：外观沿用书卡片，只是元素是 button（袋子不是条目） */
  function bagCard(b) {
    const img = b.coverMediaId ? api.thumb(b.coverMediaId) : '';
    return `<button class="char-card novel-card bag-card" data-bag="${esc(b.title)}" type="button">
      <div class="cover">
        <div class="cover-title"><span>${esc(b.title)}</span></div>
        ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        <span class="sub-chip">小说袋</span>
        ${b.bookCount ? `<span class="badge">${fmtNum(b.bookCount)}</span>` : ''}
      </div>
      <div class="info">
        <div class="name">${esc(b.title)}</div>
        <div class="sub">${b.bookCount ? `${b.bookCount} 本` : '还没有书'}</div>
      </div>
    </button>`;
  }

  function paintBody() {
    const body = root.querySelector('[data-body]');
    if (!body) return;
    const count = root.querySelector('[data-count]');

    // ① 袋子列表
    if (!state.bag) {
      const q = state.q.trim().toLowerCase();
      const list = q ? bags.filter((b) => b.title.toLowerCase().includes(q)) : bags;
      if (count) count.textContent = `${list.length} 个袋子`;
      if (!list.length) {
        body.innerHTML = `<div class="empty"><b>${bags.length ? '没有匹配的袋子' : '还没有袋子'}</b>${
          bags.length
            ? '换个关键词试试'
            : `点「＋ 新建袋子」先分个类（比如玄幻、科幻）；新建小说时填的${
                isFan() ? '原作品' : '类型'
              }也会自动变成袋子`
        }</div>`;
        return;
      }
      body.innerHTML = `<div class="char-grid">${list.map(bagCard).join('')}</div>`;
      body.querySelectorAll('[data-bag]').forEach((el) => {
        el.addEventListener('click', () => {
          state.bag = el.dataset.bag;
          paintBody();
          paintMeta();
        });
      });
      body.querySelectorAll('img').forEach(fadeIn);
      return;
    }

    // ② 袋内的书
    const list = visibleItems();
    if (count) count.textContent = `${list.length} 本`;
    const head = `<div class="bag-head">
      <button class="bag-back" data-bag-back type="button">‹ 全部袋子</button>
      <b>${esc(state.bag)}</b>
      <span>${list.length} 本</span>
    </div>`;
    if (!list.length) {
      body.innerHTML = `${head}<div class="empty">
        <b>这个袋子里还没有书</b>点右上角「＋ 新建小说」，${isFan() ? '原作品' : '类型'}填「${esc(
        state.bag
      )}」就会放进来
      </div>`;
    } else {
      body.innerHTML = `${head}<div class="char-grid">${list.map(card).join('')}</div>`;
      body.querySelectorAll('img').forEach(fadeIn);
    }
    const backBtn = body.querySelector('[data-bag-back]');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        state.bag = '';
        paintBody();
        paintMeta();
      });
    }
  }

  async function reload() {
    data = await api.novelShelf(id);
    shelf = data.shelf;
    items = data.items;
    try {
      bags = (await api.novelBags(id)).items || [];
    } catch {
      /* 袋子读不到就沿用旧的 */
    }
    paintMeta();
    paintTabs();
    paintBody();
  }

  /** 新建 / 编辑共用；返回可直接提交给接口的对象 */
  async function novelModal(item = null) {
    const groups = isFan() ? await fanficGroups() : [...new Set([...knownGroups(), ...ORIGIN_TYPES])];
    // 字段定义在 novel-fields.js：详情页「编辑资料」用的是同一份
    const { fields, transform, className } = novelFieldSet({
      fan: isFan(),
      groups,
      item,
      // 在袋子里点「新建小说」：类型预填成这个袋子
      defaults: !item && state.bag ? { novelGroup: state.bag } : null,
    });
    const v = await openModal({
      title: item ? '编辑小说' : '新建小说',
      description: item
        ? '改书名或归类文件夹会同步移动磁盘目录。'
        : `建好后可以在书里放正文文件和插图；${isFan() ? '原作品名' : '小说类型'}就是磁盘上的文件夹名。`,
      fields,
      className,
      submitText: item ? '保存' : '创建',
      transform,
    });
    if (!v) return null;
    if (!v.novelGroup) {
      toast(`请填${isFan() ? '原作品' : '小说类型'}`);
      return null;
    }
    return v;
  }

  function paintShell() {
    root.innerHTML =
      (embedded
        ? ''
        : topbarHtml({
            back: true,
            title: shelf.name,
            sub: '',
            actions: `<button class="tb-btn" data-edit-shelf>编辑库</button>`,
          })) +
      `<main class="page">
         <div class="shelf-head">
           <div class="sh-main">
             <h1 class="sh-title">${esc(shelf.name)}</h1>
             <div class="sh-meta" data-meta></div>
           </div>
           <span class="spacer"></span>
           <button class="tb-btn" data-new-bag>＋ 新建袋子</button>
           <button class="tb-btn primary" data-new-novel>＋ 新建小说</button>
         </div>
         <div class="toolbar">
           <div class="segmented" data-view></div>
           <label class="search filter-search novel-search">
             <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
               <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
             </svg>
             <input type="search" placeholder="搜索书名或作者" autocomplete="off" spellcheck="false" />
           </label>
           <span class="spacer"></span>
           <span class="count" data-count></span>
           <span data-sort></span>
         </div>
         <div data-body></div>
       </main>`;

    if (!embedded) bindTopbar(root);

    const sortDD = createDropdown({
      options: SORTS,
      value: state.sort,
      allowEmpty: false,
      className: 'sort-dd',
      onChange: (v) => {
        state.sort = v;
        paintBody();
      },
    });
    root.querySelector('[data-sort]').replaceWith(sortDD.el);

    paintMeta();
    paintTabs();
    paintBody();

    // 搜索：只重画列表，绝不重建顶栏（一重建输入框就失焦）
    const input = root.querySelector('.search input');
    if (input) {
      input.addEventListener('input', () => {
        state.q = input.value;
        paintBody();
      });
    }

    // 分类视图：本地筛选，不发请求（切 tab 要立刻响应）
    root.querySelector('[data-view]').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      state.view = btn.dataset.v;
      paintTabs();
      paintBody();
    });

    root.querySelector('[data-new-bag]').addEventListener('click', async () => {
      const v = await openModal({
        title: '新建袋子',
        description: '袋子就是按类型 / 原作分的书架，书可以后放进去。',
        fields: [
          { name: 'title', label: '袋子名称', required: true, placeholder: isFan() ? '比如：原神' : '比如：玄幻' },
        ],
        submitText: '创建',
      });
      if (!v) return;
      try {
        await api.createNovelBag(id, v.title);
        bags = (await api.novelBags(id)).items || [];
        toast(`已创建「${v.title}」`);
        paintMeta();
        paintBody();
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    root.querySelector('[data-new-novel]').addEventListener('click', async () => {
      const v = await novelModal();
      if (!v) return;
      const names = v.name
        .split(/[,，、;；\n]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 80);
      if (!names.length) return toast('书名不能为空');

      const exist = new Set(items.map((x) => x.name));
      const todo = [];
      const skipped = [];
      for (const n of names) {
        if (exist.has(n)) {
          skipped.push(n);
          continue;
        }
        exist.add(n);
        todo.push(n);
      }
      if (!todo.length) return toast(`这些书都已经有了：${skipped.slice(0, 3).join('、')}`);

      const failed = [];
      for (const name of todo) {
        try {
          await api.createCharacter({ shelfId: id, ...v, name });
        } catch {
          failed.push(name);
        }
      }
      const ok = todo.length - failed.length;
      const parts = [];
      if (ok) parts.push(todo.length === 1 && !failed.length ? `《${todo[0]}》已创建` : `已创建 ${ok} 本`);
      if (skipped.length) parts.push(`跳过 ${skipped.length} 本已存在`);
      if (failed.length) parts.push(`失败 ${failed.length} 本（${failed.slice(0, 3).join('、')}）`);
      toast(parts.join(' · ') || '创建失败');
      await reload();
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
        await api.patch(`/api/shelves/${id}`, { name: v.name });
        shelf.name = v.name;
        const t = root.querySelector('.sh-title');
        if (t) t.textContent = v.name;
        toast('已保存');
      } catch (err) {
        toast(err.message || '保存失败');
      }
    });

    const page = root.querySelector('.page');
    page.addEventListener('contextmenu', (e) => {
      const a = e.target.closest('.novel-card');
      if (a) {
        const item = items.find((x) => x.id === Number(a.dataset.id));
        if (item) {
          openContextMenu(e, [
            { label: '打开', onClick: () => goto(item.id) },
            { label: '编辑信息', onClick: () => editOne(item) },
            { label: '复制书名', onClick: () => copyName(item) },
            { label: '打开本地文件夹', onClick: () => api.reveal('character', item.id).catch(() => toast('目录已丢失')) },
            { separator: true },
            { label: '删除', danger: true, hint: '连同磁盘目录', onClick: () => removeOne(item) },
          ]);
          return;
        }
      }
      openContextMenu(e, [
        { label: '新建小说', onClick: () => root.querySelector('[data-new-novel]').click() },
        {
          label: '打开袋子',
          hint: state.bag || '全部',
          children: [
            { label: '全部袋子', hint: !state.bag ? '当前' : '', onClick: () => setBag('') },
            ...bags.map((b) => ({
              label: b.title,
              hint: state.bag === b.title ? '当前' : `${b.bookCount} 本`,
              onClick: () => setBag(b.title),
            })),
          ],
        },
        { separator: true },
        ...(root.querySelector('[data-edit-shelf]')
          ? [{ label: '编辑库', onClick: () => root.querySelector('[data-edit-shelf]').click() }]
          : []),
        { label: '刷新列表', onClick: () => reload() },
      ]);
    });
  }

  function setBag(g) {
    state.bag = g;
    paintBody();
    paintMeta();
  }

  function goto(bookId) {
    history.pushState({ from: location.pathname + location.search }, '', `/c/${bookId}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  async function copyName(item) {
    try {
      await navigator.clipboard.writeText(item.name);
      toast(`已复制「${item.name}」`);
    } catch {
      toast('复制失败，请手动选中');
    }
  }

  async function editOne(item) {
    const v = await novelModal(item);
    if (!v) return;
    try {
      const r = await api.updateCharacter(item.id, v);
      toast(r && r.dirMoved ? '已保存，磁盘目录已同步移动' : '已保存');
      await reload();
    } catch (err) {
      toast(err.message || '保存失败');
    }
  }

  async function removeOne(item) {
    const ok = await confirmDialog({
      title: `删除《${item.name}》`,
      message: '书卡、图包记录和磁盘目录会一起删掉，不能恢复。',
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      const res = await api.deleteCharacter(item.id);
      toast(charDeleteMessage(res));
      await reload();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  if (isFan()) await loadWorks();
  paintShell();
}
