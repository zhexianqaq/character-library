import { api, uploadMedia } from '../api.js';
import { esc, fmtNum, fmtBytes, fadeIn, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openLightbox } from '../components/lightbox.js';
import { openModal, confirmDialog } from '../components/modal.js';

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
           <button class="tb-btn primary" data-upload>＋ 上传图片 / 视频</button>
         </div>
         <div class="progress hidden" data-progress><i style="width:0%"></i></div>
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
      const v = await openModal({
        title: '添加标签',
        fields: [{ name: 'tag', label: '标签', required: true, placeholder: '比如：写真、制服、夜景' }],
        submitText: '添加',
      });
      if (!v || c.tags.includes(v.tag)) return;
      saveTags([...c.tags, v.tag]);
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

  async function loadPacks() {
    const body = root.querySelector('[data-body]');
    body.innerHTML = '<div class="pack-grid" data-packs></div>';
    const holder = body.querySelector('[data-packs]');
    const data = await api.packs(c.id);
    packsCache = data.items;
    if (!data.items.length) {
      holder.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <b>还没有图包</b>上传图片或视频后，会按文件名里的日期自动月份归包；也可以点「＋ 图包」手动建一个
      </div>`;
      return;
    }
    holder.innerHTML = data.items
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
            <button data-rename="${p.id}" title="重命名">✎</button>
            <button data-del="${p.id}" title="删除图包">✕</button>
          </div>
        </div>`;
      })
      .join('');
    holder.querySelectorAll('img').forEach(fadeIn);

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
      renderMasonry(holder, mediaItems, (i) => openLightbox(mediaItems, i));
    });
  }

  const progress = () => root.querySelector('[data-progress]');

  function bindUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*';
    input.style.display = 'none';
    root.appendChild(input);

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const bar = progress();
      bar.classList.remove('hidden');
      bar.querySelector('i').style.width = '0%';
      try {
        const res = await uploadMedia(c.id, files, {
          onProgress: (loaded, total) => {
            bar.querySelector('i').style.width = `${Math.round((loaded / total) * 100)}%`;
          },
        });
        bar.querySelector('i').style.width = '100%';
        const skipped = res.skipped || [];
        toast(
          skipped.length
            ? `导入 ${res.added} 个，跳过 ${skipped.length} 个（${skipped[0].reason}）`
            : `已导入 ${res.added} 个文件`
        );
        c = await api.character(id);
        paint();
        await loadPacks();
        if (mode === 'media') await loadMedia();
      } catch (err) {
        toast(err.message || '上传失败');
      } finally {
        bar.classList.add('hidden');
        input.value = '';
      }
    });

    root.querySelector('[data-upload]').addEventListener('click', () => input.click());
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
        const created = await api.createPack(c.id, { month: v.month, title: v.title });
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
  bindUpload();
  bindToolbar();
  await loadPacks();
}
