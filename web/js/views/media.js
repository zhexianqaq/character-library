import { api } from '../api.js';
import { esc, fmtBytes, fmtDur, toast, fadeIn } from '../util.js';
import { openLightbox } from '../components/lightbox.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openContextMenu } from '../components/context-menu.js';
import { sortMedia, mediaSortState } from '../components/media-sort.js';
import { escDepth } from '../esc.js';

/** 2026-10-22 */
function fmtDate(iso) {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 去掉扩展名当标题用；太长的中间截断 */
function titleOf(name) {
  return String(name || '').replace(/\.[^.\\/]+$/, '');
}

/**
 * 媒体详情页：左边看图 / 放视频，右边信息面板。
 * 序列取「同图包」，没有图包就取「同条目」，← → 在这条序列里走。
 *
 * 加载分两步：
 *   1. 只等 `api.media(id)` —— 一个请求就能画出画面，不用等整个图包的媒体列表；
 *   2. 列表在后台拉，拉回来只更新「x / y」和左右箭头状态，不重画信息栏。
 * 翻页时列表已在内存里，就只取这一张的详情（1 个请求），不再重进整个页面。
 */
export async function MediaView(root, id) {
  let item = await api.media(id);

  let siblings = [item];
  let siblingsReady = false;
  /** 列表里同图包 / 同条目的公共上下文：翻页时复用，省一次 media 请求的等待 */
  const context = { pack: item.pack, character: item.character, shelf: item.shelf };

  const indexOf = (mid) => siblings.findIndex((x) => x.id === mid);

  /**
   * 从哪个页面点进来的（角色页 / 图包页）。
   * 翻页只 replace 当前历史项，历史里始终只有一条 /i/:id，
   * 所以 ✕ 一次就能退出查看界面，而不是退回上一张。
   */
  const entryFrom = (() => {
    const st = history.state;
    const f = st && typeof st.from === 'string' ? st.from : '';
    return /^\/(c|p|s|e)\//.test(f) ? f : '';
  })();

  root.innerHTML = `
    <main class="media-page">
      <section class="mp-stage">
        <div class="mp-chip">
          <span class="mp-chip-name" data-chip-name></span>
          <button class="mp-x" data-close aria-label="关闭">✕</button>
        </div>
        <div class="mp-canvas" data-canvas></div>
        <div class="mp-actions" data-actions hidden>
          <button class="mp-cover" data-cover>设为视频封面</button>
          <button class="mp-cover ghost" data-cover-reset hidden>恢复默认封面</button>
        </div>
        <button class="mp-nav prev" data-prev aria-label="上一个">‹</button>
        <button class="mp-nav next" data-next aria-label="下一个">›</button>
      </section>
      <aside class="mp-info" data-info></aside>
    </main>`;

  /** 表情库：没有条目层级，标签 / 位置都按「库 + 图包」算 */
  /** 扁平库：没有条目层级（表情库 / 全部库），媒体直接挂在库的容器条目下面 */
  const flatKind = () =>
    item.shelf && ['emoji', 'loose', 'inbox'].includes(item.shelf.kind) ? item.shelf.kind : '';
  const isFlat = () => !!flatKind();
  /** 没有来源可退时回哪一页：表情库回 /e/，全部库回 /x/ */
  // 扁平库（表情 / 全部）现在都嵌在首页的 /s/:id 里，没有可退的历史时回那里
  const flatHome = () => `/s/${item.shelf ? item.shelf.id : ''}`;
  const groupName = () => (item.pack ? item.pack.title : isFlat() ? '未分类' : item.character.name);

  const stage = root.querySelector('.mp-stage');
  const canvas = root.querySelector('.mp-canvas');
  const info = root.querySelector('[data-info]');
  const chipName = root.querySelector('[data-chip-name]');
  const actions = root.querySelector('[data-actions]');
  const coverBtn = root.querySelector('[data-cover]');
  const resetBtn = root.querySelector('[data-cover-reset]');

  /** 封面按钮只在视频上有；「恢复默认」只在真的设过封面时出现 */
  function syncCoverButtons() {
    const isVideo = item.kind === 'video';
    actions.hidden = !isVideo;
    resetBtn.hidden = !isVideo || item.posterMs === null || item.posterMs === undefined;
  }

  /**
   * 视频画布贴合视频本身的比例，不要撑满整块再留一圈黑边。
   * 竖屏视频在宽舞台里只能到这个大小，剩下的留白交给白卡，比铺黑好看。
   */
  function fitVideo() {
    const v = canvas.querySelector('video');
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const box = stage.getBoundingClientRect();
    // 视频下面那条按钮栏占的高度要扣掉，否则视频底边会顶到按钮
    const actionsH = actions && !actions.hidden ? actions.offsetHeight + 10 : 0;
    const availW = Math.max(160, box.width - 16);
    const availH = Math.max(160, box.height - 16 - actionsH);
    const ar = v.videoWidth / v.videoHeight;
    let w = availW;
    let h = w / ar;
    if (h > availH) {
      h = availH;
      w = h * ar;
    }
    canvas.style.width = `${Math.round(w)}px`;
    canvas.style.height = `${Math.round(h)}px`;
  }

  function renderStage() {
    const isVideo = item.kind === 'video';
    // 胶囊写「条目 · 图包」，比整条文件名好认；表情库只写库 + 图包
    chipName.textContent = isFlat()
      ? [item.shelf.name, groupName()].filter(Boolean).join(' · ')
      : [item.character.name, item.pack ? item.pack.title : ''].filter(Boolean).join(' · ');
    chipName.title = item.fileName;
    canvas.style.width = '';
    canvas.style.height = '';
    if (isVideo) {
      // 静音 + 循环才能自动播放；想要声音点播放器上的音量按钮
      canvas.innerHTML = `<video data-v src="${api.original(item.id)}" controls playsinline
        autoplay muted loop preload="auto" poster="${api.thumb(item.id)}"></video>`;
      const v = canvas.querySelector('video');
      v.addEventListener('loadedmetadata', fitVideo, { once: true });
      if (v.videoWidth) fitVideo(); // 元数据已在缓存里的话事件不会再发
    } else {
      // 真动图用原件（预览图是静态首帧，动不起来）；单帧 gif 走预览图更轻
      const src = item.anim ? api.original(item.id) : api.preview(item.id);
      canvas.innerHTML = `<img data-img src="${src}" alt="${esc(item.fileName)}" />`;
      const img = canvas.querySelector('[data-img]');
      fadeIn(img);
      // 小图（表情包多为 200~300px）最多放大 2 倍并居中，硬拉满整块会糊
      const markSmall = () => {
        const nw = img.naturalWidth;
        if (!nw || nw >= 360) return;
        const box = canvas.getBoundingClientRect();
        const scale = Math.min(2, (box.width - 16) / nw, (box.height - 16) / img.naturalHeight);
        img.classList.add('is-small');
        img.style.width = `${Math.round(nw * Math.max(1, scale))}px`;
        img.style.height = `${Math.round(img.naturalHeight * Math.max(1, scale))}px`;
      };
      if (img.complete) markSmall();
      else img.addEventListener('load', markSmall, { once: true });
      img.addEventListener('click', () => openLightbox(siblings, indexOf(item.id)));
    }
    stage.classList.toggle('is-video', isVideo);
    syncCoverButtons();
  }

  function renderInfo() {
    const isVideo = item.kind === 'video';
    const res = item.width && item.height ? `${item.width} × ${item.height}` : '未知';
    const animated = !isVideo && !!item.anim;
    const place = isFlat()
      ? [item.shelf.name, groupName()].filter(Boolean).join(' / ')
      : [item.shelf.name, item.character.name, item.pack ? item.pack.title : '未归包']
          .filter(Boolean)
          .join(' / ');
    const intro =
      item.intro ||
      `与「${isFlat() ? groupName() : item.character.name}」相关的${isVideo ? '视频素材' : '图片素材'}。`;

    info.innerHTML = `
      <div class="mp-kicker">${isVideo ? 'VIDEO DETAILS' : animated ? 'GIF DETAILS' : 'IMAGE DETAILS'}</div>
      <h1 class="mp-title" title="${esc(item.fileName)}">${esc(titleOf(item.fileName))}</h1>
      <div class="mp-rows">
        <div class="mp-row"><span>分辨率</span><b>${esc(res)}</b></div>
        ${isVideo ? `<div class="mp-row"><span>时长</span><b>${fmtDur(item.durationMs) || '未知'}</b></div>` : ''}
        <div class="mp-row">
          <span>标签</span>
          <div class="mp-pills" data-tags></div>
        </div>
        <div class="mp-row block">
          <span>内容介绍</span>
          <p class="mp-intro${item.intro ? '' : ' is-auto'}" data-intro>${esc(intro)}</p>
        </div>
        ${
          isFlat()
            ? ''
            : `<div class="mp-row">
                 <span>关联</span>
                 <div class="mp-pills">
                   <a class="mp-pill" href="/c/${item.character.id}" data-link>${esc(item.character.name)}</a>
                 </div>
               </div>`
        }
        <div class="mp-row"><span>存储位置</span><b class="mp-wrap">${esc(place)}</b></div>
        <div class="mp-row"><span>存储大小</span><b>${fmtBytes(item.bytes)}</b></div>
        <div class="mp-row"><span>存储时间</span><b>${esc(fmtDate(item.createdAt))}</b></div>
      </div>
      <div class="mp-actions">
        <button class="tb-btn" data-open>全屏查看</button>
        <button class="tb-btn" data-rename>重命名</button>
        ${flatKind() === 'inbox' ? '' : '<button class="tb-btn" data-eject>移出库</button>'}
        <button class="tb-btn" data-reveal>打开位置</button>
        <button class="tb-btn danger" data-del>删除</button>
      </div>
      <div class="mp-navhint" data-navhint></div>`;

    paintTags();

    const introEl = info.querySelector('[data-intro]');
    introEl.addEventListener('click', () => editIntro(introEl));

    info.querySelector('[data-open]').addEventListener('click', () => openLightbox(siblings, indexOf(item.id)));
    info.querySelector('[data-rename]').addEventListener('click', renameItem);
    info.querySelector('[data-reveal]').addEventListener('click', () =>
      api.reveal('media', item.id).catch(() => toast('文件已丢失'))
    );
    info.querySelector('[data-del]').addEventListener('click', removeItem);
    const ejectBtn = info.querySelector('[data-eject]');
    if (ejectBtn) ejectBtn.addEventListener('click', ejectItem);

    syncNav();
  }

  /**
   * 只更新「第几张 / 共几张」和左右箭头 —— 列表在后台补回来时调它，
   * 不重建信息栏（否则正在编辑的简介会失焦）。
   */
  function syncNav() {
    const at = indexOf(item.id);
    const prev = at > 0;
    const next = at >= 0 && at < siblings.length - 1;
    root.querySelector('[data-prev]').classList.toggle('is-off', !prev);
    root.querySelector('[data-next]').classList.toggle('is-off', !next);
    const hint = info.querySelector('[data-navhint]');
    if (hint) {
      hint.textContent = `${at + 1} / ${siblings.length} · ← → 切换${
        item.kind === 'video' ? '' : ' · 点图片全屏'
      }`;
    }
  }

  /** 打开标签页：条目 / 图包 / 素材三段都在那一页 */
  function gotoTag(name) {
    if (!name) return;
    history.pushState({ from: location.pathname + location.search }, '', `/tag/${encodeURIComponent(name)}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  function paintTags() {
    const box = info.querySelector('[data-tags]');
    if (!box) return;
    const own = new Set(item.ownTags || []);
    // 图包标签和条目名 / 库标签分开口径：告诉用户该去哪一层改
    const fromPack = new Set(item.packTags || []);
    const packLabel = item.pack ? item.pack.title : '图包';
    box.innerHTML =
      (item.tags || [])
        .map((t) => {
          const mine = own.has(t);
          // 图包现在也会带上条目名标签，所以先认「条目名」这个来源，免得说成来自图包
          const src =
            t === item.character.name
              ? `条目「${esc(item.character.name)}」`
              : fromPack.has(t)
                ? `图包「${esc(packLabel)}」`
                : `条目「${esc(item.character.name)}」`;
          return `<button class="mp-pill${mine ? ' is-own' : ''}" data-tag="${esc(t)}" data-mine="${
            mine ? 1 : 0
          }" title="${mine ? `点击查看标签 · × 移除（自己打的）` : `点击查看标签 · 来自${src}`}">${esc(t)}${
            mine ? '<i data-x="1" title="移除这个标签">×</i>' : ''
          }</button>`;
        })
        .join('') + '<button class="mp-pill add" data-add-tag title="添加标签">＋</button>';

    box.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const t = btn.dataset.tag;
        // 标签本体 = 去看这个标签；「自己打的」那条用后面的 × 移除，
        // 原来点一下就删，和「标签可以点」的预期冲突。
        if (!e.target.closest('[data-x]')) {
          gotoTag(t);
          return;
        }
        await saveOwnTags((item.ownTags || []).filter((x) => x !== t));
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = btn.dataset.tag;
        const mine = btn.dataset.mine === '1';
        const from =
          t === item.character.name
            ? `条目「${item.character.name}」`
            : fromPack.has(t)
              ? `图包「${packLabel}」`
              : `条目「${item.character.name}」`;
        openContextMenu(e, [
          { label: '打开标签页', onClick: () => gotoTag(t) },
          { label: '来源', hint: mine ? '自己打的标签' : from },
          ...(mine
            ? [
                { separator: true },
                {
                  label: '移除这个标签',
                  danger: true,
                  onClick: () => saveOwnTags((item.ownTags || []).filter((x) => x !== t)),
                },
              ]
            : []),
        ]);
      });
    });
    box.querySelector('[data-add-tag]').addEventListener('click', async () => {
      const next = await openTagPicker({ title: '编辑图片标签', selected: item.ownTags || [] });
      if (!next) return;
      await saveOwnTags(next);
    });
  }

  async function saveOwnTags(next) {
    const prev = item.ownTags || [];
    item.ownTags = next;
    try {
      await api.updateMedia(item.id, { tags: next });
      item = await api.media(item.id);
      renderInfo();
      toast(next.length ? `已保存 ${next.length} 个标签` : '已清空自己的标签');
    } catch (err) {
      item.ownTags = prev;
      toast(err.message || '保存失败');
    }
  }

  async function editIntro(el) {
    if (el.querySelector('textarea')) return;
    const ta = document.createElement('textarea');
    ta.className = 'mp-intro-edit';
    ta.rows = 3;
    ta.value = item.intro || '';
    ta.placeholder = `写点关于这张${item.kind === 'video' ? '视频' : '图片'}的介绍…`;
    el.classList.remove('is-auto');
    el.textContent = '';
    el.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const commit = async () => {
      const val = ta.value.trim();
      if (val === (item.intro || '')) {
        renderInfo();
        return;
      }
      try {
        await api.updateMedia(item.id, { intro: val });
        item.intro = val;
        renderInfo();
        toast(val ? '介绍已保存' : '已恢复默认介绍');
      } catch (err) {
        toast(err.message || '保存失败');
        renderInfo();
      }
    };
    ta.addEventListener('blur', commit, { once: true });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ta.value = item.intro || '';
        ta.blur();
        // 有些环境 blur() 不派发事件，这里直接重绘兜底（不写库）
        renderInfo();
      }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) ta.blur();
    });
  }

  async function renameItem() {
    const v = await openModal({
      title: '重命名',
      description: '只改库里的显示名，磁盘上的文件保持不动。',
      fields: [{ name: 'fileName', label: '文件名', value: item.fileName, required: true }],
      submitText: '保存',
    });
    if (!v) return;
    await api.updateMedia(item.id, { fileName: v.fileName });
    item = await api.media(item.id);
    renderStage();
    renderInfo();
    document.title = `${titleOf(item.fileName)} · 资料库`;
    toast('已重命名');
  }

  /**
   * 移出库：这张退回「全部库 → 未分发」，文件跟着搬（不复制）。
   * 移完这一页已经不属于当前条目：有来源就退回去（列表会自己刷新），
   * 没有来源（直接打开链接）就去全部库，免得停在一个「不属于任何人」的详情页上。
   */
  async function ejectItem() {
    const ok = await confirmDialog(
      '把这张移出当前库？',
      '会移到「全部库 → 未分发」，之后可以在那里重新分发；磁盘上的文件跟着搬，不会复制。'
    );
    if (!ok) return;
    try {
      const r = await api.ejectMedia([item.id]);
      toast(r.merged ? '全部库里已有同一份文件，已合并（原条目这边移除）' : '已移到「全部库」');
      if (entryFrom) {
        history.back();
        return;
      }
      if (r.shelfId) {
        history.pushState({}, '', `/s/${r.shelfId}`);
        window.dispatchEvent(new CustomEvent('app:route'));
      }
    } catch (err) {
      toast(err.message || '移出失败');
    }
  }

  async function removeItem() {
    const ok = await confirmDialog('删除这个媒体？', '磁盘上的原文件也会一起删除，不可恢复。');
    if (!ok) return;
    const at = indexOf(item.id);
    const next = siblings[at + 1] || siblings[at - 1] || null;
    try {
      await api.deleteMedia(item.id);
    } catch (err) {
      toast(err.message || '删除失败');
      return;
    }
    toast('已删除');
    siblings = siblings.filter((x) => x.id !== item.id);
    if (next && siblings.length) {
      go(next.id);
    } else {
      history.pushState({}, '', `/c/${item.character.id}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    }
  }

  /** 列表在内存里就只换这一张，不再重进页面 */
  function go(mid) {
    if (!siblings.some((x) => x.id === mid)) {
      history.replaceState({ from: entryFrom }, '', `/i/${mid}`);
      window.dispatchEvent(new CustomEvent('app:route'));
      return;
    }
    loadItem(mid);
  }

  /**
   * 翻页到列表里的某一张。
   *
   * 先用列表项 + 继承来的上下文立刻画（列表项已经有 kind / 宽高 / 文件名 / 封面），
   * 再只请求这一张的详情补上简介和标签来源 —— 列表接口没有这些字段，
   * 以前靠「重进整个页面」两个请求换来的，现在一个就够。
   */
  async function loadItem(mid) {
    const sib = siblings.find((x) => x.id === mid);
    if (!sib) return;
    history.replaceState({ from: entryFrom }, '', `/i/${mid}`);
    item = { ...sib, ...context, intro: sib.intro || '' };
    renderStage();
    renderInfo();
    document.title = `${titleOf(item.fileName)} · 资料库`;
    prefetchNeighbors();
    try {
      const full = await api.media(mid);
      if (item.id !== mid) return; // 这期间又翻了，别拿旧结果盖回去
      item = full;
      renderInfo();
      prefetchNeighbors();
    } catch {
      /* 详情拿不到就停在列表项上，画面和信息都还在 */
    }
  }

  /** 预取相邻的一张图：连续按 → 时下一张已经在浏览器缓存里 */
  function prefetchNeighbors() {
    const at = indexOf(item.id);
    for (const d of [1, -1]) {
      const sib = siblings[at + d];
      if (!sib || sib.kind === 'video') continue;
      const img = new Image();
      img.src = api.preview(sib.id);
    }
  }

  /**
   * 后台补翻页序列：首屏只等 api.media(id)，图包的媒体列表在这里拉。
   * 回来后只更新「x / y」和箭头状态，不重画信息栏。
   */
  async function loadSiblings() {
    if (siblingsReady) return;
    try {
      const d = item.pack ? await api.packMedia(item.pack.id) : await api.characterMedia(item.character.id);
      if (!root.isConnected) return; // 页面已经被切走
      const list = Array.isArray(d.items) ? d.items : [];
      if (list.length) {
        siblings = list.some((x) => x.id === item.id) ? list : [item, ...list];
        // ← → 的序列跟着图包页的排序走：那边按大小 / 类型排过，这里不能还按文件名翻
        siblings = sortMedia(siblings, mediaSortState.key, mediaSortState.desc);
      }
      siblingsReady = true;
      syncNav();
      prefetchNeighbors();
    } catch {
      /* 序列拿不到就自己一个，左右键自然置灰 */
      siblingsReady = true;
    }
  }

  function step(delta) {
    const at = indexOf(item.id) + delta;
    if (at < 0 || at >= siblings.length) return;
    go(siblings[at].id);
  }

  root.querySelector('[data-prev]').addEventListener('click', () => step(-1));
  root.querySelector('[data-next]').addEventListener('click', () => step(1));

  /**
   * 把当前画面存成这个视频的封面。
   *
   * 播放中也能点：取的是**点击那一刻**的 currentTime，不是暂停时的。
   * 换完要抬一下这个 id 的缩略图版本号 —— 同一份文档里浏览器不会为一个
   * 没变过的 URL 回源，光靠 no-cache 清不掉内存里那张。
   */
  function applyPoster() {
    const v = canvas.querySelector('video');
    if (!v) return;
    v.poster = api.thumb(item.id);
    syncCoverButtons();
  }

  coverBtn.addEventListener('click', async () => {
    const v = canvas.querySelector('video');
    const dur = v ? v.duration : 0;
    if (!v || !dur || !Number.isFinite(dur)) {
      toast('视频还没加载好，稍等一下');
      return;
    }
    const at = Math.max(0, Math.min(v.currentTime || 0, dur - 0.06));
    const wasPlaying = !v.paused;
    if (wasPlaying) v.pause(); // 抽帧时画面停住，看得见存的是哪一帧
    coverBtn.disabled = true;
    coverBtn.textContent = '保存中…';
    try {
      const r = await api.setVideoPoster(item.id, at);
      item.posterMs = r.posterMs;
      api.bumpThumb(item.id);
      applyPoster();
      toast('视频封面已更新');
      fitVideo();
    } catch (err) {
      toast(err.message || '设置封面失败');
    } finally {
      coverBtn.disabled = false;
      coverBtn.textContent = '设为视频封面';
    }
  });

  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    try {
      await api.resetVideoPoster(item.id);
      item.posterMs = null;
      api.bumpThumb(item.id);
      applyPoster();
      toast('已恢复默认封面');
    } catch (err) {
      toast(err.message || '恢复失败');
    } finally {
      resetBtn.disabled = false;
    }
  });

  root.querySelector('[data-close]').addEventListener('click', () => {
    // 有来源就正常后退（翻页没往历史里叠加，所以一定是退到来源页）
    if (entryFrom) {
      history.back();
      return;
    }
    // 直接打开链接 / 从外部进来：没有可退的，就回到它所属的图包或条目
    history.pushState(
      {},
      '',
      item.pack ? `/p/${item.pack.id}` : isFlat() ? flatHome() : `/c/${item.character.id}`
    );
    window.dispatchEvent(new CustomEvent('app:route'));
  });

  let resizeTimer = 0;
  const onResize = () => {
    if (item.kind !== 'video') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitVideo, 120);
  };
  window.addEventListener('resize', onResize);

  const onKey = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    // 上面还叠着弹窗 / 灯箱 / 下拉时，键盘归它们管（Esc 已被 esc 栈吃掉）
    if (escDepth() > 0) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      root.querySelector('[data-close]').click();
    }
  };
  document.addEventListener('keydown', onKey);

  renderStage();
  renderInfo();
  loadSiblings();
  prefetchNeighbors();
  document.title = `${titleOf(item.fileName)} · 资料库`;

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    clearTimeout(resizeTimer);
  };
}
