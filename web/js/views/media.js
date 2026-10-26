import { api } from '../api.js';
import { esc, fmtBytes, fmtDur, toast, fadeIn } from '../util.js';
import { openLightbox } from '../components/lightbox.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openModal, confirmDialog } from '../components/modal.js';

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
 */
export async function MediaView(root, id) {
  let item = await api.media(id);

  let siblings = [item];
  try {
    const d = item.pack ? await api.packMedia(item.pack.id) : await api.characterMedia(item.character.id);
    if (d.items && d.items.length) siblings = d.items;
  } catch {
    /* 序列拿不到就自己一个 */
  }
  if (!siblings.some((x) => x.id === item.id)) siblings = [item, ...siblings];

  const indexOf = (mid) => siblings.findIndex((x) => x.id === mid);

  root.innerHTML = `
    <main class="media-page">
      <section class="mp-stage">
        <div class="mp-chip">
          <span class="mp-chip-name" data-chip-name></span>
          <button class="mp-x" data-close aria-label="关闭">✕</button>
        </div>
        <div class="mp-canvas" data-canvas></div>
        <button class="mp-nav prev" data-prev aria-label="上一个">‹</button>
        <button class="mp-nav next" data-next aria-label="下一个">›</button>
      </section>
      <aside class="mp-info" data-info></aside>
    </main>`;

  const stage = root.querySelector('.mp-stage');
  const canvas = root.querySelector('.mp-canvas');
  const info = root.querySelector('[data-info]');
  const chipName = root.querySelector('[data-chip-name]');

  /**
   * 视频画布贴合视频本身的比例，不要撑满整块再留一圈黑边。
   * 竖屏视频在宽舞台里只能到这个大小，剩下的留白交给白卡，比铺黑好看。
   */
  function fitVideo() {
    const v = canvas.querySelector('video');
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const box = stage.getBoundingClientRect();
    const availW = Math.max(160, box.width - 16);
    const availH = Math.max(160, box.height - 16);
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
    // 胶囊写「条目 · 图包」，比整条文件名好认
    chipName.textContent = [item.character.name, item.pack ? item.pack.title : ''].filter(Boolean).join(' · ');
    chipName.title = item.fileName;
    canvas.style.width = '';
    canvas.style.height = '';
    if (isVideo) {
      canvas.innerHTML = `<video data-v src="${api.original(item.id)}" controls playsinline preload="metadata"
        poster="${api.thumb(item.id)}"></video>`;
      const v = canvas.querySelector('video');
      v.addEventListener('loadedmetadata', fitVideo, { once: true });
      if (v.videoWidth) fitVideo(); // 元数据已在缓存里的话事件不会再发
    } else {
      canvas.innerHTML = `<img data-img src="${api.preview(item.id)}" alt="${esc(item.fileName)}" />`;
      const img = canvas.querySelector('[data-img]');
      fadeIn(img);
      img.addEventListener('click', () => openLightbox(siblings, indexOf(item.id)));
    }
    stage.classList.toggle('is-video', isVideo);
  }

  function renderInfo() {
    const isVideo = item.kind === 'video';
    const res = item.width && item.height ? `${item.width} × ${item.height}` : '未知';
    const place = [item.shelf.name, item.character.name, item.pack ? item.pack.title : '未归包']
      .filter(Boolean)
      .join(' / ');
    const intro = item.intro || `与「${item.character.name}」相关的${isVideo ? '视频素材' : '图片素材'}。`;
    const prev = indexOf(item.id) > 0;
    const next = indexOf(item.id) < siblings.length - 1;

    info.innerHTML = `
      <div class="mp-kicker">${isVideo ? 'VIDEO DETAILS' : 'IMAGE DETAILS'}</div>
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
        <div class="mp-row">
          <span>关联</span>
          <div class="mp-pills">
            <a class="mp-pill" href="/c/${item.character.id}" data-link>${esc(item.character.name)}</a>
          </div>
        </div>
        <div class="mp-row"><span>存储位置</span><b class="mp-wrap">${esc(place)}</b></div>
        <div class="mp-row"><span>存储大小</span><b>${fmtBytes(item.bytes)}</b></div>
        <div class="mp-row"><span>存储时间</span><b>${esc(fmtDate(item.createdAt))}</b></div>
      </div>
      <div class="mp-actions">
        <button class="tb-btn" data-open>全屏查看</button>
        <button class="tb-btn" data-rename>重命名</button>
        <button class="tb-btn" data-reveal>打开位置</button>
        <button class="tb-btn danger" data-del>删除</button>
      </div>
      <div class="mp-navhint">${indexOf(item.id) + 1} / ${siblings.length} · ← → 切换${isVideo ? '' : ' · 点图片全屏'}</div>`;

    paintTags();

    const introEl = info.querySelector('[data-intro]');
    introEl.addEventListener('click', () => editIntro(introEl));

    info.querySelector('[data-open]').addEventListener('click', () => openLightbox(siblings, indexOf(item.id)));
    info.querySelector('[data-rename]').addEventListener('click', renameItem);
    info.querySelector('[data-reveal]').addEventListener('click', () =>
      api.reveal('media', item.id).catch(() => toast('文件已丢失'))
    );
    info.querySelector('[data-del]').addEventListener('click', removeItem);

    root.querySelector('[data-prev]').classList.toggle('is-off', !prev);
    root.querySelector('[data-next]').classList.toggle('is-off', !next);
  }

  function paintTags() {
    const box = info.querySelector('[data-tags]');
    if (!box) return;
    const own = new Set(item.ownTags || []);
    box.innerHTML =
      (item.tags || [])
        .map((t) => {
          const mine = own.has(t);
          return `<button class="mp-pill${mine ? ' is-own' : ''}" data-tag="${esc(t)}" data-mine="${
            mine ? 1 : 0
          }" title="${mine ? '点一下移除' : `来自条目「${esc(item.character.name)}」`}">${esc(t)}${
            mine ? '<i>×</i>' : ''
          }</button>`;
        })
        .join('') + '<button class="mp-pill add" data-add-tag title="添加标签">＋</button>';

    box.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const t = btn.dataset.tag;
        if (btn.dataset.mine !== '1') {
          toast(`「${t}」是从条目继承的，去条目上改`);
          return;
        }
        await saveOwnTags((item.ownTags || []).filter((x) => x !== t));
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

  async function removeItem() {
    const ok = await confirmDialog('删除这个媒体？', '磁盘上的原文件也会一起删除，不可恢复。');
    if (!ok) return;
    await api.deleteMedia(item.id);
    toast('已删除');
    if (siblings.length > 1) {
      const at = indexOf(item.id);
      const next = siblings[at + 1] || siblings[at - 1];
      go(next.id, true);
    } else {
      history.pushState({}, '', `/c/${item.character.id}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    }
  }

  function go(mid, replace) {
    if (replace) history.replaceState({}, '', `/i/${mid}`);
    else history.pushState({}, '', `/i/${mid}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  function step(delta) {
    const at = indexOf(item.id) + delta;
    if (at < 0 || at >= siblings.length) return;
    go(siblings[at].id);
  }

  root.querySelector('[data-prev]').addEventListener('click', () => step(-1));
  root.querySelector('[data-next]').addEventListener('click', () => step(1));
  root.querySelector('[data-close]').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else {
      history.pushState({}, '', item.pack ? `/p/${item.pack.id}` : `/c/${item.character.id}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    }
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
    // 灯箱开着的时候键盘归灯箱管，否则 ← → / Esc 会被两边各处理一次
    if (document.querySelector('.lightbox')) return;
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
  document.title = `${titleOf(item.fileName)} · 资料库`;

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    clearTimeout(resizeTimer);
  };
}
