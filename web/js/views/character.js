import { api } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openLightbox } from '../components/lightbox.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openContextMenu, openMenuAtPoint } from '../components/context-menu.js';
import { mediaMenu } from '../components/media-actions.js';
import { addMediaMenuItems } from '../components/media-picker.js';
import { bindDropUpload } from '../components/dropzone.js';
import { queue } from '../upload-queue.js';

/** 复制文本：优先 Clipboard API，失败降级到 execCommand（无手势环境也能用） */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function CharacterView(root, id) {
  let c = await api.character(id);
  let mode = 'packs';
  // 虚拟角色库的三个小库；人物库不启用
  const CATEGORIES = ['官图', 'cosplay', '同人'];
  let cat = CATEGORIES[0];
  let mediaItems = [];
  let packsCache = [];

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
           <span class="spacer"></span>
           <button class="tb-btn" data-new-pack>＋ 图包</button>
           <button class="tb-btn primary" data-upload>↑ 上传素材</button>
         </div>
         ${isWorkShelf() ? '<div class="cat-row" data-cats></div>' : ''}
         <div data-body></div>
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
    el.innerHTML =
      c.tags.map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('') +
      `<button class="chip add" data-add-tag>+ 标签</button>`;
    el.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => saveTags(c.tags.filter((t) => t !== btn.dataset.tag)));
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
        if (mode === 'media') return loadMedia();
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
    const items = isWorkShelf() ? data.items.filter((p) => (p.category || '未分类') === cat) : data.items;
    if (!items.length) {
      holder.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <b>${isWorkShelf() ? `「${cat}」还没有图包` : '还没有图包'}</b>上传图片或视频后，会按文件名里的日期自动月份归包；也可以点「＋ 图包」手动建一个
      </div>`;
      return;
    }
    holder.innerHTML = items
      .map((p) => {
        const img = p.coverMediaId ? api.thumb(p.coverMediaId) : '';
        const meta = [p.imageCount ? `${p.imageCount} 图` : '', p.videoCount ? `${p.videoCount} 视频` : '']
          .filter(Boolean)
          .join(' · ');
        return `<div class="pack-card" data-pack="${p.id}">
          <a class="pack-hit" href="/p/${p.id}" data-link aria-label="${esc(p.title)}"></a>
          <div class="cover single">
            ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">空</div>'}
            ${p.videoCount ? '<span class="kind">含视频</span>' : ''}
          </div>
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="m">${meta || '0 项'}</div>
          </div>
          <div class="pack-acts">
            <button data-add-media="${p.id}" title="添加素材">＋</button>
            <button data-rename="${p.id}" title="重命名">✎</button>
            <button data-del="${p.id}" title="删除图包">✕</button>
          </div>
        </div>`;
      })
      .join('');
    holder.querySelectorAll('img').forEach(fadeIn);

    holder.querySelectorAll('[data-add-media]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pack = packsCache.find((p) => p.id === Number(btn.dataset.addMedia));
        if (!pack) return;
        const r = btn.getBoundingClientRect();
        openMenuAtPoint(Math.min(window.innerWidth - 16, r.right), r.bottom + 6, addMediaItems(pack));
      });
    });

    holder.querySelectorAll('[data-rename]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pack = packsCache.find((p) => p.id === Number(btn.dataset.rename));
        const v = await openModal({
          title: '重命名图包',
          fields: [{ name: 'title', label: '名称', value: pack ? pack.title : '', required: true }],
          submitText: '保存',
        });
        if (!v) return;
        await api.updatePack(pack.id, { title: v.title });
        toast('已重命名');
        loadPacks();
      });
    });

    holder.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pack = packsCache.find((p) => p.id === Number(btn.dataset.del));
        const ok = await confirmDialog(
          '删除图包？',
          `「${pack.title}」里的 ${pack.mediaCount} 个媒体会变成未归包，不会被删除。`
        );
        if (!ok) return;
        await api.deletePack(pack.id);
        toast('图包已删除');
        c = await api.character(id);
        paint();
        loadPacks();
      });
    });
  }

  async function loadMedia() {
    const body = root.querySelector('[data-body]');
    body.innerHTML = '<div class="masonry" data-masonry></div>';
    const holder = body.querySelector('[data-masonry]');
    const data = await api.characterMedia(c.id);
    mediaItems = data.items;
    if (!mediaItems.length) {
      holder.innerHTML = '<div class="empty" style="flex:1"><b>还没有媒体</b>点右上角上传图片或视频</div>';
      return;
    }
    requestAnimationFrame(() => {
      renderMasonry(holder, mediaItems, (i) => openLightbox(mediaItems, i), {
        onContext: (e, item) =>
          mediaMenu(e, item, {
            characterId: c.id,
            onOpen: () => openLightbox(mediaItems, mediaItems.findIndex((x) => x.id === item.id)),
            onChange: loadMedia,
          }),
      });
    });
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
        if (mode === 'media') await loadMedia();
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
      mode = btn.dataset.v;
      if (mode === 'packs') await loadPacks();
      else await loadMedia();
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
  bindIntro();
  bindToolbar();
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
