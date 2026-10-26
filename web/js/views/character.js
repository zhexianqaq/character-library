import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast, debounce, copyText } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openContextMenu } from '../components/context-menu.js';
import { mediaMenu } from '../components/media-actions.js';
import { addMediaMenuItems } from '../components/media-picker.js';
import { createDropdown } from '../components/dropdown.js';
import { bindDropUpload } from '../components/dropzone.js';
import { queue } from '../upload-queue.js';

/**
 * 资源名 → 资源。出处卡片点「原神」时要跳到资源详情，
 * 所以进角色页先拉一次索引，缓存 30 秒，点击就不用等网络。
 */
let RES_INDEX = null;
let RES_INDEX_AT = 0;
async function resourceIndex() {
  if (RES_INDEX && Date.now() - RES_INDEX_AT < 30000) return RES_INDEX;
  try {
    const d = await api.resourceIndex();
    RES_INDEX = new Map(d.items.map((x) => [x.name, x]));
  } catch {
    RES_INDEX = new Map();
  }
  RES_INDEX_AT = Date.now();
  return RES_INDEX;
}

export async function CharacterView(root, id) {
  let c = await api.character(id);
  let mode = 'packs';
  // 虚拟角色库的三个小库；人物库不启用
  const CATEGORIES = ['官图', 'cosplay', '同人'];
  let cat = CATEGORIES[0];
  let mediaItems = [];
  let packsCache = [];
  // 多选：图包视图里选图包，媒体视图里选媒体
  let selecting = false;
  const picked = new Set();
  let packsShown = [];
  // 从资源详情页点进来时带 ?res=原神，只显示带这个标签的图包
  let resFilter = new URLSearchParams(location.search).get('res') || '';

  function heroHtml() {
    const cover = c.coverMediaId ? api.thumb(c.coverMediaId) : '';
    return `<section class="hero">
      <div class="hero-bg" style="background-image:url('${cover}')"></div>
      <div class="hero-inner">
        <div class="hero-cover">
          ${cover ? `<img src="${cover}" alt="">` : '<div class="cover-empty">无封面</div>'}
        </div>
        <div class="hero-main">
          <div class="hero-head">
            <h1 class="hero-name">${esc(c.name)}</h1>
            <div class="hero-account">${esc(c.account ? '@' + c.account : (c.shelf ? c.shelf.name : ''))}</div>
          </div>
          <div class="chip-row" data-tags></div>
          <div class="hero-body">
            <div class="stat-grid">
              <div class="stat"><b>${fmtNum(c.stats.image)}</b><span>图片</span></div>
              <div class="stat"><b>${fmtNum(c.stats.video)}</b><span>视频</span></div>
              <div class="stat"><b>${fmtNum(c.packCount)}</b><span>图包</span></div>
              <div class="stat"><b>${fmtBytes(c.bytes)}</b><span>占用</span></div>
            </div>
            <div class="platform-pane" data-platforms></div>
            <div class="hero-intro" data-intro></div>
          </div>
        </div>
      </div>
    </section>`;
  }

  function shellHtml() {
    return (
      topbarHtml({ back: true, sub: '', actions: `<button class="tb-btn" data-edit>编辑资料</button>` }) +
      `<main class="page">
         <div data-hero></div>
         <div class="toolbar">
           <div class="segmented" data-view>
             <button class="on" data-v="packs">图包</button>
             <button data-v="media">全部媒体</button>
           </div>
           <div class="filter-bar" data-filter-bar hidden>
             <div class="segmented" data-f-kind>
               <button class="on" data-k="">全部</button>
               <button data-k="image">图片</button>
               <button data-k="video">视频</button>
             </div>
             <span data-f-tag></span>
             <span data-f-pack></span>
             <span data-f-cat></span>
             <label class="search filter-search">
               <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                 <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
               </svg>
               <input type="search" placeholder="搜索名称或标签" autocomplete="off" spellcheck="false" />
             </label>
             <span data-f-sort></span>
           </div>
           <span class="spacer"></span>
           <button class="tb-btn" data-select-toggle>选取</button>
           <button class="tb-btn" data-new-pack>＋ 图包</button>
           <button class="tb-btn primary" data-upload>↑ 上传素材</button>
         </div>
         <div class="filter-note" data-res-note hidden></div>
         ${isWorkShelf() ? '<div class="cat-row" data-cats></div>' : ''}
         <div data-body></div>
         <div class="sel-bar" data-selbar hidden></div>
       </main>`
    );
  }

  function paint() {
    root.querySelector('[data-hero]').innerHTML = heroHtml();
    paintTags();
    paintPlatforms();
    paintIntro();
  }

  /** 真人库放「平台账号」，虚拟角色库放「作品出处」——同一块区域，两种语义 */
  function isWorkShelf() {
    return !!(c.shelf && c.shelf.kind === 'work');
  }

  /** 真人库里叫「人物」，虚拟角色库里叫「角色」 */
  function noun() {
    return isWorkShelf() ? '角色' : '人物';
  }

  /** 平台账号：一行一个圆角卡片。有网址点开跳转，没网址复制账号；悬停可编辑/删除 */
  function paintPlatforms() {
    const pane = root.querySelector('[data-platforms]');
    if (!pane) return;
    const list = Array.isArray(c.platforms) ? c.platforms : [];
    const work = isWorkShelf();
    const head = work ? '出处' : '平台';
    const empty = work ? '还没有作品出处' : '还没有平台账号';

    pane.innerHTML = `
      <div class="pf-head">
        <span>${head}</span>
        <button class="pf-edit" data-add-platform title="${work ? '添加作品出处' : '添加平台账号'}">＋</button>
      </div>
      <div class="pf-list">
        ${
          list.length
            ? list
                .map(
                  (p, i) => `<div class="pf-card${p.url ? ' has-url' : ''}" data-i="${i}"
                    data-handle="${esc(p.handle || '')}" data-url="${esc(p.url || '')}"
                    role="button" tabindex="0"
                    title="${p.url ? `打开 ${esc(p.url)}` : `点击复制 ${esc(p.handle || '')}`}">
                    <span class="pf-name" title="${esc(p.platform || '')}">${esc(p.platform || '')}</span>
                    <span class="pf-handle">${esc(p.handle || '')}</span>
                    ${p.url ? '<span class="pf-link">↗</span>' : ''}
                    <span class="pf-acts">
                      <button class="pf-act" data-act="edit" title="编辑">✎</button>
                      <button class="pf-act" data-act="del" title="删除">✕</button>
                    </span>
                  </div>`
                )
                .join('')
            : `<span class="pf-empty">${empty}</span>`
        }
      </div>`;

    pane.querySelectorAll('.pf-card').forEach((card) => {
      const idx = Number(card.dataset.i);
      const open = () => {
        const entry = list[idx];
        if (!entry) return;
        // 出处 / 平台写的是某个资源名（原神、Fate/stay night…）→ 直接进资源页
        const hit = RES_INDEX && RES_INDEX.get(String(entry.handle || '').trim());
        if (hit) {
          history.pushState({ from: location.pathname + location.search }, '', `/r/${hit.id}`);
          window.dispatchEvent(new CustomEvent('app:route'));
          return;
        }
        if (entry.url) {
          // 用 <a> 触发，比 window.open 更稳（带 noopener 时 window.open 恒返回 null）
          const a = document.createElement('a');
          a.href = entry.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }
        copyAndFlash(card, entry.handle);
      };
      card.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) {
          e.stopPropagation();
          if (act.dataset.act === 'edit') openPlatformModal(idx);
          else deletePlatform(idx);
          return;
        }
        open();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });

    pane.querySelector('[data-add-platform]').addEventListener('click', () => openPlatformModal(-1));

    // 超过 4 条时容器内滚动；底部阴影只在「下面还有内容」时出现
    const listEl = pane.querySelector('.pf-list');
    const syncMore = () => {
      const more = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight > 2;
      pane.classList.toggle('has-more', more);
    };
    listEl.addEventListener('scroll', syncMore, { passive: true });
    requestAnimationFrame(syncMore);
  }

  async function copyAndFlash(el, handle) {
    if (!handle) return;
    const ok = await copyText(handle);
    if (ok) {
      toast(`已复制 ${handle}`);
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 900);
    } else {
      toast('复制失败，请手动选中文字');
    }
  }

  const PLATFORM_PRESETS = [
    '推特 / X',
    '微博',
    '哔哩哔哩',
    '抖音',
    '小红书',
    'Instagram',
    'YouTube',
    'Pixiv',
    'Patreon',
    'Fantia',
    'Fanbox',
    'Twitch',
    'TikTok',
  ];

  /** 虚拟角色的出处类型 */
  const ORIGIN_PRESETS = [
    '游戏',
    '动画',
    '漫画',
    '小说',
    '电影',
    '剧集',
    '特摄',
    '舞台剧',
    '同人',
    '原创',
  ];

  /**
   * 新增/编辑一条：
   * - 真人库：上排「平台 + ID」，下排选填主页网址
   * - 角色库：上排「出处类型 + 作品名」，下排选填作品链接
   * 存储复用 {platform, handle, url}：虚拟角色时 platform=类型、handle=作品名。
   */
  async function openPlatformModal(index = -1) {
    const work = isWorkShelf();
    const list = Array.isArray(c.platforms) ? c.platforms : [];
    const cur = index >= 0 ? list[index] : null;
    const v = await openModal({
      title: work
        ? cur
          ? '编辑出处'
          : '添加出处'
        : cur
          ? '编辑平台账号'
          : '添加平台账号',
      fields: work
        ? [
            {
              name: 'platform',
              label: '出处类型',
              type: 'datalist',
              options: ORIGIN_PRESETS,
              half: true,
              required: true,
              value: cur ? cur.platform : '',
              placeholder: '游戏 / 动画…',
            },
            {
              name: 'handle',
              label: '作品名',
              type: 'text',
              half: true,
              required: true,
              value: cur ? cur.handle : '',
              placeholder: '比如 原神',
            },
            {
              name: 'url',
              label: '作品链接',
              type: 'text',
              value: cur ? cur.url || '' : '',
              placeholder: '选填，官网 / 百科',
              hint: '选填。填了之后点击卡片会打开这个链接；留空则点击复制作品名。',
            },
          ]
        : [
            {
              name: 'platform',
              label: '平台',
              type: 'datalist',
              options: PLATFORM_PRESETS,
              half: true,
              required: true,
              value: cur ? cur.platform : '',
              placeholder: '选择或输入',
            },
            {
              name: 'handle',
              label: 'ID',
              type: 'text',
              half: true,
              required: true,
              value: cur ? cur.handle : '',
              placeholder: '账号 / ID',
            },
            {
              name: 'url',
              label: '主页网址',
              type: 'text',
              value: cur ? cur.url || '' : '',
              placeholder: 'https://x.com/aqua_cosplay',
              hint: '选填。填了之后点击卡片会直接打开这个网址；留空则点击复制 ID。',
            },
          ],
      submitText: cur ? '保存' : '添加',
    });
    if (!v) return;

    const entry = {
      platform: v.platform.slice(0, 20),
      handle: v.handle.slice(0, 80),
      url: normalizeSiteUrl(v.url),
    };

    const next = list.slice();
    if (index >= 0) next[index] = entry;
    else next.push(entry);

    try {
      await api.updateCharacter(c.id, { platforms: next });
      c.platforms = next;
      paintPlatforms();
      const noun = work ? '出处' : '平台账号';
      toast(index >= 0 ? `已更新${noun}` : `已添加${noun}`);
    } catch (err) {
      toast(err.message || '保存失败');
    }
  }

  async function deletePlatform(index) {
    const list = Array.isArray(c.platforms) ? c.platforms : [];
    const entry = list[index];
    if (!entry) return;
    const next = list.filter((_, i) => i !== index);
    try {
      await api.updateCharacter(c.id, { platforms: next });
      c.platforms = next;
      paintPlatforms();
      toast(`已删除 ${entry.handle || entry.platform}`);
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  /** 前端也补一次协议，让用户输 x.com/xxx 也能用 */
  function normalizeSiteUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s.slice(0, 300);
    return `https://${s}`.slice(0, 300);
  }

  function paintTags() {
    const el = root.querySelector('[data-tags]');
    if (!el) return;
    // 条目自己的名字标签是系统带的（图片也会继承它），不给删
    el.innerHTML =
      c.tags
        .map((t) => {
          const self = t === c.name;
          return `<button class="chip${self ? ' self' : ''}" data-tag="${esc(t)}" data-self="${
            self ? 1 : 0
          }" title="${self ? '条目自己的标签，改名会自动更新' : '点一下移除'}">${esc(t)}${self ? '' : ' ×'}</button>`;
        })
        .join('') + `<button class="chip add" data-add-tag>+ 标签</button>`;
    el.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.self === '1') {
          toast('这是条目自己的标签，改名会自动更新');
          return;
        }
        saveTags(c.tags.filter((t) => t !== btn.dataset.tag));
      });
    });
    el.querySelector('[data-add-tag]').addEventListener('click', async () => {
      const next = await openTagPicker({ title: '编辑标签', selected: c.tags });
      if (!next) return;
      if (next.join('\n') === c.tags.join('\n')) {
        toast('标签没有变化');
        return;
      }
      await saveTags(next);
    });
  }

  async function saveTags(next) {
    const prev = c.tags;
    c.tags = next;
    paintTags();
    try {
      await api.updateCharacter(c.id, { tags: next });
    } catch (err) {
      c.tags = prev;
      paintTags();
      toast(err.message || '保存失败');
    }
  }

  function paintIntro() {
    const el = root.querySelector('[data-intro]');
    if (!el) return;
    el.classList.toggle('is-empty', !c.intro);
    el.textContent = c.intro || '点击写点简介…';
  }

  function bindIntro() {
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-intro]');
      if (!el || el.querySelector('textarea')) return;
      const ta = document.createElement('textarea');
      ta.value = c.intro || '';
      ta.placeholder = `写点关于这个${noun()}的简介…`;
      el.classList.remove('empty');
      el.textContent = '';
      el.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.addEventListener(
        'blur',
        async () => {
          const val = ta.value.trim();
          c.intro = val;
          paintIntro();
          try {
            await api.updateCharacter(c.id, { intro: val });
          } catch (err) {
            toast(err.message || '保存失败');
          }
        },
        { once: true }
      );
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') ta.blur();
      });
    });
  }

  /** 打开媒体详情页 */
  function gotoMedia(mediaId) {
    history.pushState({ from: location.pathname + location.search }, {}, `/i/${mediaId}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  /** 打开图包页 */
  function gotoPack(packId) {
    history.pushState({}, '', `/p/${packId}`);
    window.dispatchEvent(new CustomEvent('app:route'));
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
    loadPacks();
  }

  async function editPackTags(pack) {
    const next = await openTagPicker({ title: '编辑图包标签', selected: pack.tags || [] });
    if (!next) return;
    await api.updatePack(pack.id, { tags: next });
    toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
    loadPacks();
  }

  async function dissolvePack(pack) {
    const ok = await confirmDialog(
      '解散这个图包？',
      `「${pack.title}」里的 ${pack.mediaCount} 个媒体会变成未归包，不会被删除。`
    );
    if (!ok) return;
    await api.deletePack(pack.id);
    toast('图包已解散');
    c = await api.character(id);
    paint();
    loadPacks();
  }

  async function removePack(pack) {
    const ok = await confirmDialog(
      '删除图包和它的媒体？',
      `「${pack.title}」里的 ${pack.mediaCount} 个媒体会一起删除，磁盘文件也会删掉，不可恢复。`
    );
    if (!ok) return;
    await api.deletePack(pack.id, { withMedia: true });
    toast('图包已删除');
    c = await api.character(id);
    paint();
    loadPacks();
  }

  /** 图包「添加素材」的四个来源（右键菜单和卡片上的 ＋ 共用） */
  function addMediaItems(pack) {
    return addMediaMenuItems({
      charId: c.id,
      charName: c.name,
      packId: pack.id,
      packTitle: pack.title,
      onUpload: () => pickFiles({ packId: pack.id, packTitle: pack.title }),
      onDone: refreshAfterMediaChange,
    });
  }

  /** 素材归属变了：角色统计、图包封面、当前列表都要重拉 */
  function refreshAfterMediaChange() {
    api
      .character(id)
      .then((next) => {
        c = next;
        paint();
        return loadPacks();
      })
      .then(() => {
        if (mode === 'media') return loadMedia(true);
        return null;
      })
      .catch((err) => toast(err.message || '刷新失败'));
  }

  /** 图包 / 平台 / 空白处的右键 */
  function bindContextMenus() {
    const page = root.querySelector('.page');
    page.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tile')) return;  // 瀑布流自己处理

      const pf = e.target.closest('.pf-card');
      if (pf) {
        const i = Number(pf.dataset.i);
        const entry = (c.platforms || [])[i];
        if (!entry) return;
        openContextMenu(e, [
          { label: '编辑', onClick: () => openPlatformModal(i) },
          { label: '复制', onClick: () => copyAndFlash(pf, entry.handle) },
          { separator: true },
          { label: '删除', danger: true, onClick: () => deletePlatform(i) },
        ]);
        return;
      }

      const card = e.target.closest('.pack-card');
      if (card) {
        const packId = Number(card.dataset.pack);
        const pack = packsCache.find((p) => p.id === packId);
        if (!pack) return;
        openContextMenu(e, [
          { label: '打开', onClick: () => gotoPack(pack.id) },
          { label: '编辑名称', onClick: () => renamePack(pack) },
          { label: '编辑标签', onClick: () => editPackTags(pack) },
          { label: '添加素材', hint: '4 种来源', children: addMediaItems(pack) },
          { label: '打开本地文件夹', onClick: () => api.reveal('pack', pack.id).catch(() => toast('目录已丢失')) },
          { separator: true },
          { label: '解散图包', hint: '保留媒体', onClick: () => dissolvePack(pack) },
          { label: '删除', danger: true, hint: '连媒体', onClick: () => removePack(pack) },
        ]);
        return;
      }

      openContextMenu(e, [
        { label: '上传素材', hint: '也可以直接拖进来', onClick: () => pickFiles() },
        { label: '打开上传队列', onClick: () => { history.pushState({}, '', '/uploads'); window.dispatchEvent(new CustomEvent('app:route')); } },
        { label: '新建图包', onClick: () => root.querySelector('[data-new-pack]').click() },
        { separator: true },
        { label: `编辑${noun()}资料`, onClick: () => root.querySelector('[data-edit]').click() },
      ]);
    });
  }

  // ---------- 多选 ----------
  const selBar = () => root.querySelector('[data-selbar]');

  function resetSelection() {
    selecting = false;
    picked.clear();
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
      <span class="sel-n">已选 <b>0</b> ${mode === 'packs' ? '个图包' : '个媒体'}</span>
      <button data-sel="all">全选</button>
      ${mode === 'packs' ? '<button data-sel="dissolve">解散</button>' : '<button data-sel="move">移动到…</button>'}
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
    if (mode === 'packs') loadPacks();
    else loadMedia();
    buildSelBar();
  }

  function exitSelect() {
    resetSelection();
    if (mode === 'packs') loadPacks();
    else loadMedia();
  }

  function togglePick(id) {
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    const el = root.querySelector(`.tile[data-id="${id}"], .pack-card[data-pack="${id}"]`);
    if (el) el.classList.toggle('is-sel', picked.has(id));
    syncSelCount();
  }

  function selectAllShown() {
    const ids = mode === 'packs' ? packsShown.map((p) => p.id) : mediaItems.map((m) => m.id);
    const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
    if (allOn) picked.clear();
    else ids.forEach((id) => picked.add(id));
    root.querySelectorAll('.pack-card, .tile').forEach((el) => {
      const id = Number(el.dataset.pack || el.dataset.id);
      el.classList.toggle('is-sel', picked.has(id));
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
    if (action === 'dissolve') bulkPacks('dissolve');
    else if (action === 'del') mode === 'packs' ? bulkPacks('delete') : bulkMediaDelete();
    else if (action === 'move') bulkMediaMove();
  }

  async function bulkPacks(action) {
    const ids = [...picked];
    const del = action === 'delete';
    const ok = await confirmDialog(
      del ? `删除 ${ids.length} 个图包和里面的媒体？` : `解散 ${ids.length} 个图包？`,
      del
        ? '图包里的图片 / 视频会一起删掉，磁盘文件也会删，不可恢复。'
        : '只删图包这个壳，里面的媒体会变成未归包，文件一个都不动。'
    );
    if (!ok) return;
    try {
      const res = await api.bulkPacks(ids, action);
      toast(del ? `已删除 ${res.done} 个图包 · ${res.removed} 个媒体` : `已解散 ${res.done} 个图包`);
      resetSelection();
      c = await api.character(id);
      paint();
      await loadPacks();
    } catch (err) {
      toast(err.message || '操作失败');
    }
  }

  async function bulkMediaDelete() {
    const ids = [...picked];
    const ok = await confirmDialog(`删除 ${ids.length} 个媒体？`, '磁盘上的原件也会一起删掉，不可恢复。');
    if (!ok) return;
    try {
      const res = await api.bulkMedia(ids, 'delete');
      toast(`已删除 ${res.done} 个媒体`);
      resetSelection();
      c = await api.character(id);
      paint();
      if (mode === 'media') await loadMedia(true);
      else await loadPacks();
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  async function bulkMediaMove() {
    let data;
    try {
      data = await api.packs(c.id);
    } catch (err) {
      toast(err.message || '图包列表读取失败');
      return;
    }
    const v = await openModal({
      title: `移动 ${picked.size} 个媒体`,
      description: '只改所属图包，磁盘文件留在原地。',
      fields: [
        {
          name: 'packId',
          label: '目标图包',
          type: 'select',
          required: true,
          // 新建放第一项，图包多的时候不用滚到底才找得到
          options: [
            { value: '__new__', label: '＋ 新建图包…' },
            ...data.items.map((p) => ({
              value: String(p.id),
              label: `${p.category ? `${p.category} / ` : ''}${p.title}（${p.mediaCount}）`,
            })),
          ],
          value: data.items.length ? String(data.items[0].id) : '__new__',
        },
      ],
      submitText: '移动',
    });
    if (!v) return;

    let packId = Number(v.packId);
    if (v.packId === '__new__') {
      const nv = await openModal({
        title: '新建图包',
        description: '建好后这些媒体会直接移进去。',
        fields: [
          { name: 'title', label: '图包名称', required: true, placeholder: '比如：夏日写真' },
          { name: 'month', label: '日期（可选）', type: 'month' },
        ],
        submitText: '创建并移动',
      });
      if (!nv) return;
      try {
        const created = await api.createPack(c.id, {
          title: nv.title,
          month: nv.month,
          category: packCategory(),
        });
        packId = created.id;
      } catch (err) {
        toast(err.message || '创建失败');
        return;
      }
    }

    try {
      const res = await api.bulkMedia([...picked], 'move', packId);
      toast(res.skipped ? `已移动 ${res.done} 个，跳过 ${res.skipped} 个` : `已移动 ${res.done} 个`);
      resetSelection();
      if (mode === 'media') await loadMedia(true);
      else await loadPacks();
    } catch (err) {
      toast(err.message || '移动失败');
    }
  }

  /** 「来自资源 X」的提示条，清除后恢复全部图包 */
  function paintResNote() {
    const el = root.querySelector('[data-res-note]');
    if (!el) return;
    el.hidden = !resFilter;
    if (!resFilter) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<span>来自资源「${esc(resFilter)}」· 只看带这个标签的图包</span>
      <button data-clear-res>显示全部</button>`;
    el.querySelector('[data-clear-res]').addEventListener('click', () => {
      resFilter = '';
      history.replaceState({}, '', location.pathname);
      paintResNote();
      loadPacks();
    });
  }

  /** 当前小库；人物库或「未分类」时返回 null */
  function packCategory() {
    return isWorkShelf() && CATEGORIES.includes(cat) ? cat : null;
  }

  /** 三个小库的切换条，带各库图包数 */
  function paintCats() {
    const el = root.querySelector('[data-cats]');
    if (!el) return;
    const counts = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
    let uncategorized = 0;
    for (const p of packsCache) {
      const k = p.category || '未分类';
      if (k in counts) counts[k] += 1;
      else uncategorized += 1;
    }
    const tabs = CATEGORIES.map((k) => ({ k, n: counts[k] }));
    if (uncategorized) tabs.push({ k: '未分类', n: uncategorized });
    el.innerHTML = tabs
      .map((t) => `<button class="cat${t.k === cat ? ' on' : ''}" data-cat="${esc(t.k)}">${esc(t.k)}<i>${t.n}</i></button>`)
      .join('');
    el.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.cat === cat) return;
        cat = btn.dataset.cat;
        el.querySelectorAll('.cat').forEach((x) => x.classList.toggle('on', x.dataset.cat === cat));
        loadPacks();
      });
    });
  }

  async function loadPacks() {
    const body = root.querySelector('[data-body]');
    body.innerHTML = '<div class="pack-grid" data-packs></div>';
    const holder = body.querySelector('[data-packs]');
    const data = await api.packs(c.id);
    packsCache = data.items;
    paintCats();
    let items = isWorkShelf() ? data.items.filter((p) => (p.category || '未分类') === cat) : data.items;
    if (resFilter) items = items.filter((p) => (p.tags || []).includes(resFilter));
    packsShown = items;
    if (!items.length) {
      holder.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <b>${
          resFilter
            ? `「${esc(resFilter)}」下还没有图包`
            : isWorkShelf()
              ? `「${cat}」还没有图包`
              : '还没有图包'
        }</b>${
          resFilter
            ? `给图包加上「${esc(resFilter)}」标签，它就会出现在这里`
            : '上传图片或视频后，会按文件名里的日期自动月份归包；也可以点「＋ 图包」手动建一个'
        }
      </div>`;
      return;
    }
    holder.innerHTML = items
      .map((p) => {
        const img = p.coverMediaId ? api.thumb(p.coverMediaId) : '';
        const meta = [p.imageCount ? `${p.imageCount} 图` : '', p.videoCount ? `${p.videoCount} 视频` : '']
          .filter(Boolean)
          .join(' · ');
        const on = selecting && picked.has(p.id);
        return `<div class="pack-card${on ? ' is-sel' : ''}" data-pack="${p.id}">
          ${selecting ? '<span class="tick" aria-hidden="true"></span>' : ''}
          <a class="pack-hit" href="/p/${p.id}" data-link aria-label="${esc(p.title)}"></a>
          <div class="cover single">
            ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">空</div>'}
          </div>
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="m">${meta || '0 项'}</div>
          </div>
        </div>`;
      })
      .join('');
    holder.querySelectorAll('img').forEach(fadeIn);

    // 选择模式下点卡片 = 勾选，必须用捕获阶段拦住 .pack-hit 的 data-link 跳转
    if (selecting) {
      holder.addEventListener(
        'click',
        (e) => {
          const card = e.target.closest('.pack-card');
          if (!card) return;
          e.preventDefault();
          e.stopPropagation();
          togglePick(Number(card.dataset.pack));
        },
        true
      );
    }

  }

  // ---------- 全部媒体的筛选 ----------
  const filters = { kind: '', tag: '', pack: '', cat: '', q: '', sort: 'new' };
  let mediaAll = [];
  let tagDD = null;
  let packDD = null;
  let sortDD = null;

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

    if (isWorkShelf()) {
      const catDD = createDropdown({
        options: CATEGORIES.map((k) => ({ value: k, label: k })),
        allowEmpty: true,
        emptyLabel: '全部小库',
        onChange: (v) => {
          filters.cat = v;
          renderMedia();
        },
      });
      bar.querySelector('[data-f-cat]').replaceWith(catDD.el);
    } else {
      bar.querySelector('[data-f-cat]')?.remove();
    }

    sortDD = createDropdown({
      options: [
        { value: 'new', label: '最新添加' },
        { value: 'old', label: '最早添加' },
        { value: 'name', label: '按名称' },
        { value: 'size', label: '文件最大' },
        { value: 'sizeAsc', label: '文件最小' },
      ],
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

  /** 标签 / 图包下拉的候选值跟着当前条目的媒体走 */
  function refreshFilterOptions() {
    if (!tagDD) return;
    const counts = new Map();
    for (const m of mediaAll) {
      for (const t of m.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    tagDD.setOptions(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => ({ value: t, label: `${t}（${n}）` }))
    );
    packDD.setOptions([
      { value: '__none__', label: '未归包' },
      ...packsCache.map((p) => ({
        value: String(p.id),
        label: `${p.category ? `${p.category} / ` : ''}${p.title}（${p.mediaCount}）`,
      })),
    ]);
  }

  function packCategoryOf(packId) {
    const p = packsCache.find((x) => x.id === Number(packId));
    return p ? p.category || '' : '';
  }

  function applyFilters(list) {
    let out = list;
    if (filters.kind) out = out.filter((m) => m.kind === filters.kind);
    if (filters.tag) out = out.filter((m) => (m.tags || []).includes(filters.tag));
    if (filters.pack) {
      out =
        filters.pack === '__none__'
          ? out.filter((m) => !m.packId)
          : out.filter((m) => String(m.packId) === filters.pack);
    }
    if (filters.cat) out = out.filter((m) => packCategoryOf(m.packId) === filters.cat);
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
    else if (filters.sort === 'name') sorted.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh-Hans-CN'));
    else if (filters.sort === 'size') sorted.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    else if (filters.sort === 'sizeAsc') sorted.sort((a, b) => (a.bytes || 0) - (b.bytes || 0));
    else sorted.sort((a, b) => b.id - a.id);
    return sorted;
  }

  function renderMedia() {
    const holder = root.querySelector('[data-body] [data-masonry]');
    if (!holder) return;
    mediaItems = applyFilters(mediaAll);
    holder.innerHTML = '';
    if (!mediaItems.length) {
      holder.innerHTML = mediaAll.length
        ? '<div class="empty" style="flex:1"><b>没有符合条件的媒体</b>换个筛选条件试试</div>'
        : '<div class="empty" style="flex:1"><b>还没有媒体</b>点右上角上传图片或视频</div>';
      return;
    }
    requestAnimationFrame(() => {
      renderMasonry(
        holder,
        mediaItems,
        (i) => {
          if (selecting) {
            togglePick(mediaItems[i].id);
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
                  characterId: c.id,
                  onOpen: () => gotoMedia(item.id),
                  onChange: () => loadMedia(true),
                }),
        }
      );
    });
  }

  async function loadMedia(force = false) {
    const body = root.querySelector('[data-body]');
    body.innerHTML = '<div class="masonry" data-masonry></div>';
    if (force || !mediaAll.length) {
      const [mediaRes, packsRes] = await Promise.all([api.characterMedia(c.id), api.packs(c.id)]);
      mediaAll = mediaRes.items;
      packsCache = packsRes.items;
      refreshFilterOptions();
    }
    renderMedia();
  }

  /**
   * 选本地文件进上传队列。packId 指定传进哪个图包，
   * 不指定就按文件名里的日期自动归包（走当前小库）。
   */
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
        charId: c.id,
        charName: c.name,
        packId,
        packTitle,
        category: packCategory(),
      });
      toast(n ? `已加入上传队列 ${n} 个文件 · 点右下角看进度` : '这些文件已经在队列里了');
    });
    input.click();
  }

  /** 队列里所有文件都结束后刷新页面数据（不打断当前浏览就靠这个） */
  function watchUploads() {
    queue.onIdle = async () => {
      if (!root.isConnected || !root.querySelector('.page')) return;
      try {
        c = await api.character(id);
        paint();
        await loadPacks();
        if (mode === 'media') await loadMedia(true);
      } catch {
        /* 页面可能已经被切走了 */
      }
    };
  }

  function bindToolbar() {
    root.querySelector('[data-view]').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn || btn.dataset.v === mode) return;
      root.querySelectorAll('[data-view] button').forEach((b) => b.classList.toggle('on', b === btn));
      resetSelection();
      mode = btn.dataset.v;
      const bar = root.querySelector('[data-filter-bar]');
      if (bar) bar.hidden = mode !== 'media';
      if (mode === 'packs') await loadPacks();
      else await loadMedia();
    });

    root.querySelector('[data-select-toggle]').addEventListener('click', () => {
      if (selecting) exitSelect();
      else enterSelect();
    });

    root.querySelector('[data-new-pack]').addEventListener('click', async () => {
      const v = await openModal({
        title: '新建图包',
        description: '两个都可以留空：有名称就用名称，只有日期就用日期，都没填就用今天。',
        fields: [
          { name: 'title', label: '图包名称', placeholder: '比如：夏日写真、棚拍合集' },
          {
            name: 'month',
            label: '日期（可选）',
            type: 'month',
            hint: '有名称时，这里当作拍摄年月，用于排序；留空则排在最后',
          },
        ],
        submitText: '创建',
      });
      if (!v) return;
      if (!v.title && !v.month) {
        // 两个都空，直接用今天，不再弹二次确认
      }
      try {
        const created = await api.createPack(c.id, {
          month: v.month,
          title: v.title,
          category: packCategory(),
        });
        toast(
          created.autoMonth ? `已用今天创建「${created.title}」` : `图包「${created.title}」已创建`
        );
        if (mode !== 'packs') {
          mode = 'packs';
          root.querySelectorAll('[data-view] button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'packs'));
        }
        loadPacks();
      } catch (err) {
        toast(err.message || '创建失败');
      }
    });

    root.querySelector('[data-edit]').addEventListener('click', async () => {
      const v = await openModal({
        title: `编辑${noun()}资料`,
        fields: [
          { name: 'name', label: `${noun()}名`, value: c.name, required: true },
          { name: 'account', label: '账号 / 来源', value: c.account || '' },
          { name: 'intro', label: '简介', type: 'textarea', value: c.intro || '' },
        ],
        submitText: '保存',
      });
      if (!v) return;
      await api.updateCharacter(c.id, v);
      c = await api.character(id);
      paint();
      toast('已保存');
    });
  }

  root.innerHTML = shellHtml();
  bindTopbar(root);
  paint();
  paintResNote();
  resourceIndex();
  bindIntro();
  bindToolbar();
  buildFilterBar();
  root.querySelector('[data-upload]').addEventListener('click', () => pickFiles());
  bindContextMenus();
  watchUploads();
  bindDropUpload(root.querySelector('.page'), () => ({
    charId: c.id,
    charName: c.name,
    packId: null,
    packTitle: '',
    category: packCategory(),
  }));
  await loadPacks();

  // 从右键菜单「添加素材」跳过来时，直接弹选择框
  if (new URLSearchParams(location.search).get('upload')) {
    history.replaceState({}, '', `/c/${id}`);
    pickFiles();
  }
}
