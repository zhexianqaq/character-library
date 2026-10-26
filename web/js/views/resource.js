import { api } from '../api.js';
import { esc, fmtNum, fadeIn, toast, copyText } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openContextMenu } from '../components/context-menu.js';
import { RES_CATS } from './resources.js';

/**
 * 资源详情：顶部是封面 / 名称 / 分类 / 标签 / 简介，
 * 下面是所有打了同名标签（或出处写了这个名称）的角色 / 人物。
 */
export async function ResourceView(root, id) {
  let d = await api.resource(id);
  let r = d.resource;
  let related = d.related;

  root.innerHTML =
    topbarHtml({ back: true, title: r.shelf.name || '资源库', sub: '', actions: `<button class="tb-btn" data-edit>编辑</button>` }) +
    `<main class="page">
       <section class="hero">
         <div class="hero-bg" data-bg></div>
         <div class="hero-inner">
           <div class="hero-cover" data-cover></div>
           <div class="hero-main">
             <div class="hero-head">
               <h1 class="hero-name">${esc(r.name)}</h1>
               <div class="hero-account">${esc(r.category || '未分类')}</div>
             </div>
             <div class="chip-row" data-tags></div>
             <div class="hero-body">
               <div class="stat-grid" data-stats></div>
               <div class="hero-intro" data-intro></div>
             </div>
           </div>
         </div>
       </section>
       <div class="section-head">
         <h2>相关角色 / 人物</h2>
         <span class="meta" data-related-count></span>
       </div>
       <div class="char-grid" data-related></div>
     </main>`;

  bindTopbar(root);

  function paintHero() {
    const cover = r.coverMediaId ? api.thumb(r.coverMediaId) : '';
    const packs = related.reduce((n, x) => n + (x.packCount || 0), 0);
    const media = related.reduce((n, x) => n + (x.mediaCount || 0), 0);
    root.querySelector('[data-stats]').innerHTML = `
      <div class="stat"><b>${fmtNum(related.length)}</b><span>相关条目</span></div>
      <div class="stat"><b>${fmtNum(packs)}</b><span>图包</span></div>
      <div class="stat"><b>${fmtNum(media)}</b><span>素材</span></div>
      <div class="stat"><b>${esc(r.category || '—')}</b><span>分类</span></div>`;
    root.querySelector('[data-bg]').style.backgroundImage = cover ? `url('${cover}')` : 'none';
    root.querySelector('[data-cover]').innerHTML = cover
      ? `<img src="${cover}" alt="">`
      : '<div class="cover-empty">无封面</div>';
    paintTags();
    paintIntro();
  }

  /** 编辑资源标签；资源名本身始终留在标签里，它是关联的依据 */
  async function editTags() {
    const own = (r.tags || []).filter((t) => t !== r.name);
    const next = await openTagPicker({ title: `「${r.name}」的标签`, selected: own });
    if (!next) return;
    try {
      await api.updateCharacter(r.id, { tags: [...new Set([...next, r.name])] });
      r = (await api.resource(id)).resource;
      paintHero();
      toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
    } catch (err) {
      toast(err.message || '保存失败');
    }
  }

  function paintTags() {
    const box = root.querySelector('[data-tags]');
    box.innerHTML =
      (r.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('') +
      '<button class="chip add" data-add-tag>+ 标签</button>';
    box.querySelector('[data-add-tag]').addEventListener('click', editTags);
  }

  function paintIntro() {
    const el = root.querySelector('[data-intro]');
    el.classList.toggle('is-empty', !r.intro);
    el.textContent = r.intro || '点击写点简介…';
  }

  root.querySelector('[data-intro]').addEventListener('click', (e) => {
    const el = e.currentTarget;
    if (el.querySelector('textarea')) return;
    const ta = document.createElement('textarea');
    ta.value = r.intro || '';
    ta.placeholder = '写点关于这个资源的简介…';
    el.textContent = '';
    el.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener(
      'blur',
      async () => {
        const val = ta.value.trim();
        r.intro = val;
        paintIntro();
        try {
          await api.updateCharacter(r.id, { intro: val });
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

  function paintRelated() {
    const grid = root.querySelector('[data-related]');
    root.querySelector('[data-related-count]').textContent = related.length ? `${related.length} 个` : '';
    if (!related.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <b>还没有关联的条目</b>
        去「人物库 / 角色库」给条目打上「${esc(r.name)}」标签，或者把出处写成「${esc(r.name)}」，就会出现在这里
      </div>`;
      return;
    }
    grid.innerHTML = related
      .map((c) => {
        const img = c.coverMediaId ? api.thumb(c.coverMediaId) : '';
        const kind = c.kind === 'work' ? '角色' : '人物';
        return `<a class="char-card" href="/c/${c.id}?res=${encodeURIComponent(r.name)}" data-link data-entry="${c.id}">
          <div class="cover">
            ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">待添加</div>'}
            <span class="badge">${fmtNum(c.mediaCount)}</span>
          </div>
          <div class="info">
            <div class="name">${esc(c.name)}</div>
            <div class="sub">${kind} · ${c.packCount} 个图包</div>
          </div>
        </a>`;
      })
      .join('');
    grid.querySelectorAll('img').forEach(fadeIn);
  }

  /** 打开条目；withRes=true 时带上标签筛选 */
  function gotoEntry(entryId, withRes) {
    const q = withRes ? `?res=${encodeURIComponent(r.name)}` : '';
    history.pushState({ from: location.pathname + location.search }, '', `/c/${entryId}${q}`);
    window.dispatchEvent(new CustomEvent('app:route'));
  }

  async function copyName(text, label) {
    const ok = await copyText(text);
    toast(ok ? `已复制「${text}」` : '复制失败，请手动选中文字');
  }

  async function deleteResource() {
    const ok = await confirmDialog(
      `删除「${r.name}」？`,
      '只删掉这张资源卡片，角色 / 人物和它们的媒体都不受影响。'
    );
    if (!ok) return;
    try {
      await api.deleteCharacter(r.id);
      toast('已删除');
      history.pushState({}, '', `/rs/${r.shelf.id}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    } catch (err) {
      toast(err.message || '删除失败');
    }
  }

  function allMenu() {
    return [
      { label: '编辑资源', onClick: () => root.querySelector('[data-edit]').click() },
      { label: '编辑标签', hint: '关联靠标签', onClick: editTags },
      { label: '复制资源名', hint: '给条目打标签用', onClick: () => copyName(r.name) },
      { separator: true },
      { label: '删除资源', danger: true, onClick: deleteResource },
    ];
  }

  function entryMenu(c) {
    return [
      { label: '打开条目', onClick: () => gotoEntry(c.id, false) },
      {
        label: `只看「${r.name}」的图包`,
        hint: `${c.packCount} 个图包`,
        onClick: () => gotoEntry(c.id, true),
      },
      { label: '打开本地文件夹', onClick: () => api.reveal('character', c.id).catch(() => toast('目录已丢失')) },
      { separator: true },
      { label: '复制条目名', onClick: () => copyName(c.name) },
    ];
  }

  function bindContextMenus() {
    const page = root.querySelector('.page');
    if (!page) return;
    page.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('[data-entry]');
      if (card) {
        const c = related.find((x) => x.id === Number(card.dataset.entry));
        if (c) {
          openContextMenu(e, entryMenu(c));
          return;
        }
      }
      openContextMenu(e, allMenu());
    });
  }

  bindContextMenus();

  root.querySelector('[data-edit]').addEventListener('click', async () => {
    const v = await openModal({
      title: '编辑资源',
      fields: [
        { name: 'name', label: '名称', value: r.name, required: true },
        {
          name: 'category',
          label: '分类',
          type: 'select',
          options: RES_CATS.map((c) => ({ value: c, label: c })),
          value: r.category || RES_CATS[0],
        },
        { name: 'intro', label: '简介', type: 'textarea', value: r.intro || '' },
        {
          name: 'coverMediaId',
          label: '封面',
          type: 'select',
          options: [
            { value: '', label: '自动（借用关联角色的封面）' },
            ...related
              .filter((x) => x.coverMediaId)
              .map((x) => ({ value: String(x.coverMediaId), label: `用「${x.name}」的封面` })),
          ],
          value: r.ownCoverId ? String(r.ownCoverId) : '',
          hint: '自动模式会借用关联角色的封面图。',
        },
      ],
      submitText: '保存',
    });
    if (!v) return;
    try {
      await api.updateCharacter(r.id, {
        name: v.name,
        category: v.category,
        intro: v.intro,
        coverMediaId: v.coverMediaId ? Number(v.coverMediaId) : null,
      });
      d = await api.resource(id);
      r = d.resource;
      related = d.related;
      // hero 里的名字 / 分类是写死在模板里的，最简单的办法是重画整页
      history.replaceState({}, '', location.pathname + location.search);
      window.dispatchEvent(new CustomEvent('app:route'));
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });

  paintHero();
  paintRelated();
  document.title = `${r.name} · 资料库`;
}
