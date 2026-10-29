import { api } from '../api.js';
import {
  esc,
  fmtNum,
  fadeIn,
  toast,
  copyText,
  charDeleteMessage,
  splitAliases,
  isSelectAllKey,
  isTypingTarget,
  keepScroll,
} from '../util.js';
import { applyPickClick } from '../selection.js';
import { escDepth } from '../esc.js';
import { topbarHtml, bindTopbar, bindTopbarSearch } from '../components/topbar.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { openTagPicker } from '../components/tag-picker.js';
import { openContextMenu } from '../components/context-menu.js';
import { RES_CATS } from './resources.js';
import { createPackSort, sortPacks } from '../components/pack-sort.js';

/**
 * 资源详情：顶部是封面 / 名称 / 分类 / 标签 / 简介，
 * 下面是所有打了同名标签（或出处写了这个名称）的角色 / 人物。
 */
export async function ResourceView(root, id) {
  const [data, packData] = await Promise.all([api.resource(id), api.packs(id).catch(() => ({ items: [] }))]);
  let d = data;
  let r = d.resource;
  let related = d.related;
  // 资源自带一个「官方」图包（结构同其它库：库/条目/图包/图片|视频）
  let packs = packData.items || [];
  // 顶栏搜索：同时过滤「官方图包」和「相关角色 / 人物」两块
  let q = '';
  // 多选：picked 存 id，跨搜索过滤保留；「全选」只作用于当前筛选结果
  let selecting = false;
  const picked = new Set();
  let anchorId = null;

  root.innerHTML =
    topbarHtml({
      back: true,
      title: r.shelf.name || '作品录',
      sub: '',
      search: true,
      placeholder: '搜索条目或图包',
      actions: `<button class="tb-btn" data-edit>编辑</button>`,
    }) +
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
               <div class="alias-pane" data-aliases></div>
               <div class="hero-intro" data-intro></div>
             </div>
           </div>
         </div>
       </section>
       <div class="section-head">
         <h2>官方图包</h2>
         <span class="meta" data-pack-count></span>
         <span class="spacer"></span>
         <span data-pack-sort></span>
       </div>
       <div class="pack-grid" data-packs></div>
       <div class="section-head">
         <h2>相关角色 / 人物</h2>
         <span class="meta" data-related-count></span>
         <button class="tb-btn" data-add-char>＋ 添加角色</button>
         <button class="tb-btn" data-select-toggle>选取</button>
       </div>
       <div class="char-grid" data-related></div>
       <div class="sel-bar" data-selbar hidden></div>
     </main>`;

  bindTopbar(root);

  function paintHero() {
    const cover = r.coverMediaId ? api.thumb(r.coverMediaId) : '';
    const relatedPacks = related.reduce((n, x) => n + (x.packCount || 0), 0);
    const media = related.reduce((n, x) => n + (x.mediaCount || 0), 0);
    // 「图包」= 关联条目的图包 + 这个资源自己的（官方）图包
    const packTotal = relatedPacks + packs.length;
    root.querySelector('[data-stats]').innerHTML = `
      <div class="stat"><b>${fmtNum(related.length)}</b><span>相关条目</span></div>
      <div class="stat"><b>${fmtNum(packTotal)}</b><span>图包</span></div>
      <div class="stat"><b>${fmtNum(media)}</b><span>素材</span></div>
      <div class="stat"><b>${esc(r.category || '—')}</b><span>分类</span></div>`;
    root.querySelector('[data-bg]').style.backgroundImage = cover ? `url('${cover}')` : 'none';
    root.querySelector('[data-cover]').innerHTML = cover
      ? `<img src="${cover}" alt="">`
      : '<div class="cover-empty">无封面</div>';
    paintTags();
    paintAliases();
    paintIntro();
  }

  /** 别名栏：简称 / 日文名 / 英文名。游戏、动画、电影、剧集都走这一栏 */
  function paintAliases() {
    const el = root.querySelector('[data-aliases]');
    if (!el) return;
    const list = Array.isArray(r.aliases) ? r.aliases : [];
    el.innerHTML =
      `<div class="pf-head"><span>别名</span><button class="pf-edit" data-add-alias title="编辑别名" aria-label="编辑别名">＋</button></div>` +
      `<div class="alias-list">${
        list.length
          ? list.map((a) => `<span class="alias-chip" title="${esc(a)}">${esc(a)}</span>`).join('')
          : '<span class="alias-empty">简称 / 日文名 / 英文名</span>'
      }</div>`;
  }

  async function editAliases() {
    const cur = Array.isArray(r.aliases) ? r.aliases : [];
    const v = await openModal({
      title: '编辑别名',
      description: '简称、原名、日文名、英文名都放这里 —— 一行一个，也可以直接用逗号隔开。',
      fields: [
        {
          name: 'aliases',
          label: '别名',
          type: 'textarea',
          value: cur.join('\n'),
          placeholder: 'FGO\nFate/Grand Order\nフェイト・グランドオーダー',
        },
      ],
      submitText: '保存',
    });
    if (!v) return;
    const next = String(v.aliases || '')
      .split(/[,，、\n]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 20);
    const prev = r.aliases;
    r.aliases = next;
    paintAliases();
    try {
      await api.updateCharacter(r.id, { aliases: next });
      toast(next.length ? '别名已保存' : '别名已清空');
    } catch (err) {
      r.aliases = prev;
      paintAliases();
      toast(err.message || '保存失败');
    }
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
    syncIntroMore();
  }

  /** 简介框定高，长文在框内滚；底边渐隐提示「下面还有」 */
  function syncIntroMore() {
    const el = root.querySelector('[data-intro]');
    if (!el) return;
    el.classList.toggle('has-more', el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }

  // 别名栏整块可点（标题、＋、chip、空白都行）
  root.querySelector('[data-aliases]').addEventListener('click', editAliases);

  const introEl = root.querySelector('[data-intro]');
  introEl.addEventListener('scroll', syncIntroMore, { passive: true });
  let introRO = null;
  if (typeof ResizeObserver === 'function') {
    introRO = new ResizeObserver(() => syncIntroMore());
    introRO.observe(introEl);
  }

  introEl.addEventListener('click', (e) => {
    const el = e.currentTarget;
    if (el.querySelector('textarea')) return;
    const ta = document.createElement('textarea');
    ta.value = r.intro || '';
    ta.placeholder = '写点关于这个资源的简介…';
    el.textContent = '';
    el.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // Esc = 放弃这次修改（点空白处才是保存）
    let cancelled = false;
    ta.addEventListener(
      'blur',
      async () => {
        if (cancelled) {
          paintIntro();
          return;
        }
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
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      cancelled = true;
      ta.value = r.intro || '';
      ta.blur();
      // 有些环境 blur() 不派发事件，这里直接重绘兜底
      paintIntro();
    });
  });

  /** 顶栏搜索用：任意一段文本命中即可 */
  function hit(...vals) {
    const kw = q.trim().toLowerCase();
    if (!kw) return true;
    return vals.some((v) => String(v === null || v === undefined ? '' : v).toLowerCase().includes(kw));
  }

  /** 条目：名称 / 平台账号 / 别名 都能搜 */
  function visibleRelated() {
    return related.filter((c) => hit(c.name, c.account, ...(c.aliases || [])));
  }

  /** 图包：标题 / 小库分类 / 标签 都能搜 */
  function visiblePacks() {
    return packs.filter((p) => hit(p.title, p.category, ...(p.tags || [])));
  }

  function paintRelated() {
    const grid = root.querySelector('[data-related]');
    const list = visibleRelated();
    const kw = q.trim();
    root.querySelector('[data-related-count]').textContent = kw
      ? `${list.length} / ${related.length}`
      : related.length
        ? `${related.length} 个`
        : '';
    const toggle = root.querySelector('[data-select-toggle]');
    if (toggle) toggle.textContent = selecting ? '完成' : '选取';
    if (!list.length) {
      grid.innerHTML = kw
        ? `<div class="empty" style="grid-column:1/-1">
             <b>没有匹配「${esc(kw)}」的条目</b>这个资源下只有 ${related.length} 个关联条目，换个关键词试试
           </div>`
        : `<div class="empty" style="grid-column:1/-1">
             <b>还没有关联的条目</b>
             点上面的「＋ 添加角色」挑几个，或者去「人物集 / 角色集」给条目打上「${esc(r.name)}」标签
           </div>`;
      syncSelCount();
      return;
    }
    grid.innerHTML = list
      .map((c) => {
        const img = c.coverMediaId ? api.thumb(c.coverMediaId) : '';
        const kind = c.kind === 'work' ? '角色' : '人物';
        const on = selecting && picked.has(c.id);
        return `<a class="char-card${on ? ' is-sel' : ''}" href="/c/${c.id}?res=${encodeURIComponent(r.name)}" data-link data-entry="${c.id}">
          ${selecting ? '<span class="tick" aria-hidden="true"></span>' : ''}
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
    syncSelCount();
  }

  // ---------- 多选：相关角色 / 人物 ----------
  const selBar = () => root.querySelector('[data-selbar]');

  function resetSelection() {
    selecting = false;
    picked.clear();
    anchorId = null;
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
    // 选中项可能有一部分被当前搜索挡住了，这里点一下数
    const visible = new Set(visibleRelated().map((c) => c.id));
    let hidden = 0;
    picked.forEach((id) => {
      if (!visible.has(id)) hidden += 1;
    });
    const hint = bar.querySelector('.sel-hide');
    if (hint) hint.textContent = hidden ? `（${hidden} 个不在当前筛选里）` : '';
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
      <span class="sel-n">已选 <b>0</b> 个条目<span class="sel-hide"></span></span>
      <button data-sel="all">全选当前结果</button>
      <button data-sel="move">移动到作品…</button>
      <button data-sel="unlink">移除关联</button>
      <button data-sel="del" class="danger">删除</button>
      <button data-sel="exit" class="primary">完成</button>`;
    bar.querySelectorAll('button[data-sel]').forEach((b) => {
      b.addEventListener('click', () => onSelAction(b.dataset.sel));
    });
    syncSelCount();
  }

  function markSelecting(on) {
    selecting = on;
    root.classList.toggle('is-selecting', on);
    const t = root.querySelector('[data-select-toggle]');
    if (t) t.textContent = on ? '完成' : '选取';
  }

  function enterSelect() {
    keepScroll(() => {
      picked.clear();
      anchorId = null;
      markSelecting(true);
      paintRelated();
      buildSelBar();
    });
  }

  function exitSelect() {
    keepScroll(() => {
      resetSelection();
      paintRelated();
    });
  }

  function pickByClick(entryId, ev) {
    const ordered = visibleRelated().map((c) => c.id);
    const r2 = applyPickClick({ picked, ordered, id: entryId, ev, anchorId });
    anchorId = r2.anchorId;
    syncPickMarks();
  }

  function syncPickMarks() {
    root.querySelectorAll('.char-card[data-entry]').forEach((el) => {
      el.classList.toggle('is-sel', picked.has(Number(el.dataset.entry)));
    });
    syncSelCount();
  }

  /** 全选「当前筛选结果」—— 搜索框里打了字就只选筛出来的那些 */
  function selectAllShown(toggle = true) {
    const ids = visibleRelated().map((c) => c.id);
    const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
    if (toggle && allOn) picked.clear();
    else ids.forEach((id) => picked.add(id));
    anchorId = ids.length ? ids[ids.length - 1] : null;
    syncPickMarks();
  }

  function selectAllViaKeyboard() {
    const ids = visibleRelated().map((c) => c.id);
    if (!ids.length) return false;
    if (selecting) {
      selectAllShown(false);
      return true;
    }
    picked.clear();
    ids.forEach((id) => picked.add(id));
    anchorId = ids[ids.length - 1];
    markSelecting(true);
    paintRelated();
    buildSelBar();
    return true;
  }

  /** 关联变了就重拉一次详情：hero 里的统计、区头计数都跟着动 */
  async function reloadRelated() {
    const fresh = await api.resource(id);
    d = fresh;
    r = fresh.resource;
    related = fresh.related;
    paintHero();
    paintRelated();
  }

  async function onSelAction(action) {
    if (action === 'exit') return exitSelect();
    if (action === 'all') return selectAllShown();
    if (!picked.size) return;
    const ids = [...picked];
    if (action === 'unlink') return unlinkEntries(ids);
    if (action === 'del') return deleteEntries(ids);
    if (action === 'move') return moveEntries(ids);
  }

  async function unlinkEntries(ids) {
    const names = ids.map((x) => (related.find((c) => c.id === x) || {}).name).filter(Boolean);
    const ok = await confirmDialog(
      `从「${r.name}」移除 ${ids.length} 个条目？`,
      `只会去掉「${r.name}」这个标签和同名出处，条目、图包、媒体都不动。${
        names.length ? ` 分别是：${names.slice(0, 6).join('、')}${names.length > 6 ? ' 等' : ''}。` : ''
      }`
    );
    if (!ok) return;
    try {
      const res = await api.resourceLink(r.id, ids, 'remove');
      toast(`已移除 ${res.changed} 个关联`);
      resetSelection();
      await reloadRelated();
    } catch (err) {
      toast(err.message || '移除失败');
    }
  }

  async function deleteEntries(ids) {
    const items = ids.map((x) => related.find((c) => c.id === x)).filter(Boolean);
    const media = items.reduce((n, c) => n + (c.mediaCount || 0), 0);
    const packsN = items.reduce((n, c) => n + (c.packCount || 0), 0);
    const ok = await confirmDialog(
      `删除 ${ids.length} 个条目？`,
      `会连同 ${packsN} 个图包、${media} 个媒体一起删掉，磁盘文件也一起删，不可撤销。` +
        ` 只想断开关联的话，用「移除关联」。`
    );
    if (!ok) return;
    let okN = 0;
    const failed = [];
    for (const cid of ids) {
      try {
        await api.deleteCharacter(cid);
        okN += 1;
      } catch {
        failed.push(cid);
      }
    }
    toast(failed.length ? `已删除 ${okN} 个，${failed.length} 个失败` : `已删除 ${okN} 个条目`);
    resetSelection();
    await reloadRelated();
  }

  /** 把关联挪到另一张作品卡：等价于「去掉本作品的标签 + 打上目标作品的标签」 */
  async function moveEntries(ids) {
    if (!ids.length) return;
    const idx = await api.resourceIndex().catch(() => ({ items: [] }));
    const targets = (idx.items || []).filter((x) => x.id !== r.id);
    if (!targets.length) return toast('作品录里还没有别的作品');
    const v = await openModal({
      title: `移动 ${ids.length} 个条目`,
      description: `把关联从「${r.name}」换到目标作品上：只改标签和出处，媒体、目录都不动。`,
      fields: [
        {
          name: 'targetId',
          label: '目标作品',
          type: 'select',
          options: targets.map((x) => ({
            value: String(x.id),
            label: x.category ? `${x.name}（${x.category}）` : x.name,
          })),
          value: String(targets[0].id),
        },
      ],
      submitText: '移动',
    });
    if (!v || !v.targetId) return;
    try {
      const res = await api.resourceLink(r.id, ids, 'move', Number(v.targetId));
      toast(`已移动 ${res.changed} 个条目`);
      resetSelection();
      await reloadRelated();
    } catch (err) {
      toast(err.message || '移动失败');
    }
  }

  async function renameEntry(c) {
    const v = await openModal({
      title: '重命名条目',
      description: '只改显示名，磁盘目录不会跟着改。',
      fields: [{ name: 'name', label: '名称', value: c.name, required: true }],
      submitText: '保存',
    });
    if (!v) return;
    try {
      await api.updateCharacter(c.id, { name: v.name });
      toast('已重命名');
      await reloadRelated();
    } catch (err) {
      toast(err.message || '重命名失败');
    }
  }

  /**
   * 给这个作品挑条目：搜服务端（条目多也不卡），勾完一次性打标签。
   * 已经在关联里的不会出现在候选里（查询时排除）。
   */
  async function addEntries() {
    const chosen = new Set();
    let keyword = '';
    let seq = 0;
    let list = [];

    const dom = document.createElement('div');
    dom.className = 'pick-wrap';
    dom.innerHTML = `
      <label class="search pick-search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
        </svg>
        <input type="search" data-pick-q placeholder="搜条目名 / 别名 / 账号" autocomplete="off" spellcheck="false" />
      </label>
      <div class="pick-head">
        <label class="pick-all"><input type="checkbox" data-pick-all /> 全选当前结果</label>
        <span class="pick-count" data-pick-count></span>
      </div>
      <div class="pick-list" data-pick-list></div>`;

    const listEl = dom.querySelector('[data-pick-list]');
    const allBox = dom.querySelector('[data-pick-all]');
    const countEl = dom.querySelector('[data-pick-count]');
    const qEl = dom.querySelector('[data-pick-q]');

    const syncAll = () => {
      const ids = list.map((x) => x.id);
      allBox.checked = ids.length > 0 && ids.every((x) => chosen.has(x));
      allBox.disabled = !ids.length;
      countEl.textContent = chosen.size ? `已选 ${chosen.size} 个` : '';
      const okBtn = dom.closest('.modal') && dom.closest('.modal').querySelector('[data-ok]');
      if (okBtn) okBtn.disabled = chosen.size === 0;
    };

    const paintList = () => {
      if (!list.length) {
        listEl.innerHTML = keyword
          ? `<div class="pick-empty">没有匹配「${esc(keyword)}」的条目</div>`
          : '<div class="pick-empty">没有可关联的条目了 —— 都已经在这个作品下</div>';
        syncAll();
        return;
      }
      listEl.innerHTML = list
        .map((c) => {
          const on = chosen.has(c.id);
          const sub = [c.kind === 'work' ? '角色' : c.kind === 'novel' ? '小说' : '人物', c.shelfName, `${fmtNum(c.mediaCount)} 个媒体`]
            .filter(Boolean)
            .join(' · ');
          return `<label class="pick-item${on ? ' is-on' : ''}" data-pick="${c.id}">
            <input type="checkbox"${on ? ' checked' : ''} />
            <span class="nm">${esc(c.name)}</span>
            <span class="mt">${esc(sub)}</span>
          </label>`;
        })
        .join('');
      syncAll();
    };

    const load = async () => {
      const my = ++seq;
      const res = await api.resourceCandidates(r.id, keyword).catch(() => ({ items: [] }));
      if (my !== seq) return;
      list = res.items || [];
      paintList();
    };

    let timer = 0;
    qEl.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        keyword = qEl.value.trim();
        load();
      }, 220);
    });
    // 弹窗里 Enter 会直接提交，搜索框里只当「刷新列表」
    qEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      keyword = qEl.value.trim();
      load();
    });
    dom.querySelector('[data-pick-list]').addEventListener('click', (e) => {
      const row = e.target.closest('[data-pick]');
      if (!row) return;
      e.preventDefault();
      const cid = Number(row.dataset.pick);
      if (chosen.has(cid)) chosen.delete(cid);
      else chosen.add(cid);
      row.classList.toggle('is-on', chosen.has(cid));
      const box = row.querySelector('input');
      if (box) box.checked = chosen.has(cid);
      syncAll();
    });
    allBox.addEventListener('change', () => {
      const ids = list.map((x) => x.id);
      if (allBox.checked) ids.forEach((x) => chosen.add(x));
      else ids.forEach((x) => chosen.delete(x));
      paintList();
    });

    const v = await openModal({
      title: `给「${r.name}」添加角色`,
      description: '只建立关联（打上和作品同名的标签），不移动也不复制任何文件。',
      fields: [],
      className: 'pick-modal',
      submitText: '关联',
      onMount: (body) => {
        body.appendChild(dom);
        syncAll();
        load();
      },
      transform: () => ({ ids: [...chosen] }),
    });
    if (!v || !v.ids || !v.ids.length) return;
    try {
      const res = await api.resourceLink(r.id, v.ids, 'add');
      toast(`已关联 ${res.changed} 个条目`);
      await reloadRelated();
    } catch (err) {
      toast(err.message || '关联失败');
    }
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
      const res = await api.deleteCharacter(r.id);
      toast(charDeleteMessage(res));
      history.pushState({}, '', `/s/${r.shelf.id}`);
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
      { label: '添加角色…', hint: '关联已有条目', onClick: addEntries },
      {
        label: selecting ? '退出多选' : '进入多选模式',
        onClick: () => (selecting ? exitSelect() : enterSelect()),
      },
      { label: '全选当前结果', onClick: () => selectAllShown(false) },
      { separator: true },
      { label: '删除资源', danger: true, onClick: deleteResource },
    ];
  }

  function entryMenu(c) {
    const on = picked.has(c.id);
    return [
      { label: '打开条目', onClick: () => gotoEntry(c.id, false) },
      {
        label: `只看「${r.name}」的图包`,
        hint: `${c.packCount} 个图包`,
        onClick: () => gotoEntry(c.id, true),
      },
      { label: '打开本地文件夹', onClick: () => api.reveal('character', c.id).catch(() => toast('目录已丢失')) },
      { separator: true },
      { label: '重命名…', onClick: () => renameEntry(c) },
      { label: '移动到其他作品…', onClick: () => moveEntries([c.id]) },
      { label: '复制条目名', onClick: () => copyName(c.name) },
      { separator: true },
      {
        label: selecting ? '退出多选' : '进入多选模式',
        onClick: () => (selecting ? exitSelect() : enterSelect()),
      },
      selecting
        ? {
            label: on ? '取消选中这个条目' : '把这个条目加入选中',
            onClick: () => {
              if (on) picked.delete(c.id);
              else picked.add(c.id);
              syncPickMarks();
            },
          }
        : null,
      { separator: true },
      { label: `从「${r.name}」移除`, hint: '只断开关联，不删条目', onClick: () => unlinkEntries([c.id]) },
      { label: '删除条目…', danger: true, onClick: () => deleteEntries([c.id]) },
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

  // ---------- 相关角色的交互接线 ----------
  root.querySelector('[data-add-char]').addEventListener('click', addEntries);
  root.querySelector('[data-select-toggle]').addEventListener('click', () => {
    if (selecting) exitSelect();
    else enterSelect();
  });

  /* 选取态里点卡片 = 勾选，不跳转。
     capture 阶段拦下来，document 上那个 a[data-link] 的跳转处理器就收不到这次点击了 */
  root.querySelector('[data-related]').addEventListener(
    'click',
    (e) => {
      if (!selecting) return;
      const card = e.target.closest('.char-card[data-entry]');
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      pickByClick(Number(card.dataset.entry), e);
    },
    true
  );

  /** Esc 退出多选；Ctrl+A 全选当前筛选结果；Delete 删除选中 */
  const onPageKey = (e) => {
    if (isTypingTarget(e.target)) return;
    if (escDepth() > 0) return; // 弹窗 / 右键菜单 / 下拉开着时键盘归它们
    if (isSelectAllKey(e) && selectAllViaKeyboard()) {
      e.preventDefault();
      return;
    }
    if (!selecting) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSelect();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!picked.size) return;
      e.preventDefault();
      deleteEntries([...picked]);
      return;
    }
    if (e.key === 'Enter' && picked.size === 1) {
      e.preventDefault();
      gotoEntry([...picked][0], false);
    }
  };
  document.addEventListener('keydown', onPageKey);

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
        {
          name: 'aliases',
          label: '别名',
          value: (r.aliases || []).join('、'),
          placeholder: '简称、原名、日文名、英文名，用顿号或逗号隔开',
          hint: '详情页里点「别名」那一栏也能直接改',
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
        aliases: splitAliases(v.aliases),
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

  /** 该作品的图包（现在固定有一个「官方」）。点进去就是标准的图包页，能直接上传图片 / 视频 */
  /** 图包排序：默认时间倒序，和条目页保持一致 */
  let packSort = { key: 'date', desc: true };

  function paintPacks() {
    const grid = root.querySelector('[data-packs]');
    if (!grid) return;
    const list = visiblePacks();
    const kw = q.trim();
    root.querySelector('[data-pack-count]').textContent = kw
      ? `${list.length} / ${packs.length}`
      : packs.length
        ? `${packs.length} 个`
        : '';
    if (!list.length) {
      grid.innerHTML = kw
        ? `<div class="empty" style="grid-column:1/-1"><b>没有匹配「${esc(kw)}」的图包</b>这个资源下只有 ${packs.length} 个图包</div>`
        : '<div class="empty" style="grid-column:1/-1"><b>还没有图包</b>刷新一下试试</div>';
      return;
    }
    grid.innerHTML = sortPacks(list, packSort.key, packSort.desc)
      .map((p) => {
        const img = p.coverMediaId ? api.thumb(p.coverMediaId) : '';
        const meta =
          [p.imageCount ? `${p.imageCount} 图` : '', p.videoCount ? `${p.videoCount} 视频` : '']
            .filter(Boolean)
            .join(' · ') || '0 项';
        return `<div class="pack-card" data-pack="${p.id}">
          <a class="pack-hit" href="/p/${p.id}" data-link aria-label="${esc(p.title)}"></a>
          <div class="cover single">
            ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">空</div>'}
          </div>
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="m">${meta}</div>
          </div>
        </div>`;
      })
      .join('');
    grid.querySelectorAll('img').forEach(fadeIn);
  }

  // 排序控件：只重画图包区，不动别处
  const packSortCtl = createPackSort({
    key: packSort.key,
    desc: packSort.desc,
    onChange: (key, desc) => {
      packSort = { key, desc };
      paintPacks();
    },
  });
  const sortSlot = root.querySelector('[data-pack-sort]');
  if (sortSlot) sortSlot.replaceWith(packSortCtl.el);

  // 顶栏搜索：只重画下面两块列表，hero 不动（里面没有可搜的东西）
  bindTopbarSearch(root, (val) => {
    q = val;
    paintRelated();
    paintPacks();
  });

  paintHero();
  paintRelated();
  paintPacks();
  document.title = `${r.name} · 资料库`;

  // 换页时把这个视图的键盘监听摘掉，否则会越积越多
  return () => {
    document.removeEventListener('keydown', onPageKey);
    if (introRO) introRO.disconnect();
  };
}
