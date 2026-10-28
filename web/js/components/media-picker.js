import { api } from '../api.js';
import { esc, fmtBytes, toast, fadeIn, debounce } from '../util.js';
import { pushEsc } from '../esc.js';

// 范围都是相对的：人物集叫「本角色」，表情包这种扁平库叫「本库」
const scopesFor = (selfLabel) => [
  { key: 'all', label: '全部素材' },
  { key: 'character', label: selfLabel },
  { key: 'loose', label: '未分类' },
  { key: 'filed', label: '已归包' },
];

const PAGE = 36;

/**
 * 素材挑选器：从库里已有的素材中挑若干项加进图包。
 * scope 决定初始范围（全部 / 本角色 / 未分类 / 已归包），弹窗里还能再切。
 * 返回 { moved, skipped } 或 null（取消）。
 */
export function openMediaPicker({
  charId,
  charName = '',
  packId,
  packTitle = '',
  scope = 'all',
  selfLabel = '本角色',
}) {
  return new Promise((resolve) => {
    const SCOPES = scopesFor(selfLabel);
    let curScope = SCOPES.some((s) => s.key === scope) ? scope : 'all';
    let curKind = '';
    let keyword = '';
    let offset = 0;
    let hasMore = false;
    let loading = false;
    let total = 0;
    let items = [];
    const selected = new Map();
    let seq = 0;

    const root = document.createElement('div');
    root.className = 'picker-mask';
    root.innerHTML = `
      <div class="picker" role="dialog" aria-modal="true" aria-label="添加素材">
        <header class="pk-head">
          <div class="pk-title">
            <h3>添加素材</h3>
            <span class="pk-sub">${packTitle ? `加入「${esc(packTitle)}」` : '选择要加入的素材'}</span>
          </div>
          <button class="pk-x" data-close aria-label="关闭">✕</button>
        </header>

        <div class="pk-tools">
          <div class="segmented pk-scope" data-scope>
            ${SCOPES.map(
              (s) => `<button class="${s.key === curScope ? 'on' : ''}" data-s="${s.key}">${s.label}</button>`
            ).join('')}
          </div>
          <div class="segmented pk-kind" data-kind>
            <button class="on" data-k="">全部</button>
            <button data-k="image">图片</button>
            <button data-k="video">视频</button>
          </div>
          <label class="search pk-search">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
            </svg>
            <input type="search" placeholder="搜索文件名或标签" autocomplete="off" spellcheck="false" />
          </label>
          <button class="tb-btn pk-all" data-all>全选已加载</button>
        </div>

        <div class="pk-body" data-body>
          <div class="pk-grid" data-grid></div>
          <div class="pk-more" data-more></div>
        </div>

        <footer class="pk-foot">
          <span class="pk-count" data-count>已选 0 项</span>
          <span class="spacer"></span>
          <button class="tb-btn" data-cancel>取消</button>
          <button class="tb-btn primary" data-ok disabled>添加</button>
        </footer>
      </div>`;

    document.body.appendChild(root);
    const bodyEl = root.querySelector('[data-body]');
    const gridEl = root.querySelector('[data-grid]');
    const moreEl = root.querySelector('[data-more]');
    const countEl = root.querySelector('[data-count]');
    const okBtn = root.querySelector('[data-ok]');

    let offEsc = null;
    function close(payload) {
      document.removeEventListener('keydown', onKey);
      if (offEsc) {
        offEsc();
        offEsc = null;
      }
      root.remove();
      resolve(payload);
    }

    function syncFoot() {
      const n = selected.size;
      const cross = [...selected.values()].filter((it) => it.characterId !== charId).length;
      countEl.innerHTML = n
        ? `已选 <b>${n}</b> 项${cross ? `<i>其中 ${cross} 项来自其他角色，会移动过来</i>` : ''}`
        : `共 ${total} 项可选`;
      okBtn.disabled = n === 0;
      okBtn.textContent = n ? `添加 ${n} 项` : '添加';
    }

    function cellHtml(it, index) {
      const inPack = it.packId && Number(it.packId) === Number(packId);
      const on = selected.has(it.id);
      const other = it.characterId !== charId;
      return `<button class="pk-cell${on ? ' is-on' : ''}${inPack ? ' is-in' : ''}"
          data-id="${it.id}" data-i="${index}"${inPack ? ' disabled' : ''}
          title="${esc(it.fileName)} · ${fmtBytes(it.bytes)}">
        <img src="${api.thumb(it.id)}" alt="" loading="lazy" decoding="async">
        ${it.kind === 'video' ? '<span class="pk-play">▶</span>' : ''}
        <span class="pk-tick" aria-hidden="true"></span>
        ${inPack ? '<span class="pk-flag">已在包内</span>' : other ? `<span class="pk-flag from">${esc(it.characterName)}</span>` : ''}
      </button>`;
    }

    // 事件委托：翻页只追加 DOM，不重复绑监听
    gridEl.addEventListener('click', (e) => {
      const el = e.target.closest('.pk-cell');
      if (!el || el.classList.contains('is-in')) return;
      const id = Number(el.dataset.id);
      const it = items.find((x) => x.id === id);
      if (!it) return;
      if (selected.has(id)) selected.delete(id);
      else selected.set(id, it);
      el.classList.toggle('is-on', selected.has(id));
      syncFoot();
    });

    async function load(reset) {
      if (loading) return;
      if (!reset && !hasMore) return;
      loading = true;
      const my = ++seq;
      if (reset) {
        offset = 0;
        items = [];
        hasMore = false;
        gridEl.innerHTML = '';
        moreEl.textContent = '加载中…';
      } else {
        moreEl.textContent = '加载中…';
      }

      try {
        const res = await api.pickMedia({
          scope: curScope,
          charId: curScope === 'character' ? charId : undefined,
          packId,
          kind: curKind || undefined,
          q: keyword || undefined,
          limit: PAGE,
          offset,
        });
        if (my !== seq) return; // 搜索/切范围比请求快，丢掉过期结果
        total = res.total || 0;
        hasMore = !!res.hasMore;
        offset += res.items.length;
        items = items.concat(res.items);
        gridEl.insertAdjacentHTML('beforeend', res.items.map((it, i) => cellHtml(it, items.length - res.items.length + i)).join(''));
        gridEl.querySelectorAll('img').forEach(fadeIn);
        if (reset && !items.length) {
          gridEl.innerHTML = `<div class="pk-empty">这里没有素材${
            curScope === 'loose' ? '——所有素材都已归包' : ''
          }</div>`;
        }
        moreEl.textContent = hasMore ? '继续往下滚加载更多' : items.length ? `已经到底 · 共 ${total} 项` : '';
      } catch (err) {
        moreEl.textContent = err.message || '加载失败';
      } finally {
        loading = false;
        syncFoot();
      }
    }

    // 滚动到底自动翻页
    bodyEl.addEventListener('scroll', () => {
      if (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 360) load(false);
    }, { passive: true });

    root.querySelector('[data-scope]').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-s]');
      if (!btn || btn.dataset.s === curScope) return;
      curScope = btn.dataset.s;
      root.querySelectorAll('[data-scope] button').forEach((b) => b.classList.toggle('on', b === btn));
      load(true);
    });

    root.querySelector('[data-kind]').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-k]');
      if (!btn) return;
      curKind = btn.dataset.k;
      root.querySelectorAll('[data-kind] button').forEach((b) => b.classList.toggle('on', b === btn));
      load(true);
    });

    const onSearch = debounce(() => load(true), 260);
    root.querySelector('.pk-search input').addEventListener('input', (e) => {
      keyword = String(e.target.value || '').trim();
      onSearch();
    });

    root.querySelector('[data-all]').addEventListener('click', () => {
      let n = 0;
      for (const it of items) {
        if (it.packId && Number(it.packId) === Number(packId)) continue;
        if (selected.has(it.id)) continue;
        selected.set(it.id, it);
        n += 1;
      }
      gridEl.querySelectorAll('.pk-cell:not(.is-in)').forEach((el) => el.classList.add('is-on'));
      if (!n) toast('已加载的素材都选上了');
      syncFoot();
    });

    okBtn.addEventListener('click', async () => {
      const ids = [...selected.keys()];
      if (!ids.length) return;
      okBtn.disabled = true;
      okBtn.textContent = '添加中…';
      try {
        const res = await api.addMediaToPack(packId, ids);
        const skipped = res.skipped || [];
        toast(
          skipped.length
            ? `已添加 ${res.moved} 项，跳过 ${skipped.length} 项（${skipped[0].reason}）`
            : `已添加 ${res.moved} 项`
        );
        close(res);
      } catch (err) {
        toast(err.message || '添加失败');
        okBtn.disabled = false;
        syncFoot();
      }
    });

    root.querySelector('[data-close]').addEventListener('click', () => close(null));
    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close(null);
    });

    const onKey = (e) => {
      // Esc 交给 esc 栈；这里只留 ⌘/Ctrl + Enter 直接加入
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size) okBtn.click();
    };
    document.addEventListener('keydown', onKey);
    offEsc = pushEsc(() => close(null), () => root.isConnected);

    syncFoot();
    load(true);
  });
}

/** 图包「添加素材」的四个来源，右键菜单和按钮都复用这一份 */
export function addMediaMenuItems({ charId, charName, packId, packTitle, onUpload, onDone, selfLabel = '本角色' }) {
  const open = (scope) => () =>
    openMediaPicker({ charId, charName, packId, packTitle, scope, selfLabel }).then((res) => {
      if (res && res.moved && onDone) onDone(res);
    });
  return [
    { label: '从全部素材添加', hint: '整个资料库', onClick: open('all') },
    { label: `从${selfLabel}素材添加`, hint: charName || '', onClick: open('character') },
    { label: '从未分类素材添加', hint: '还没归包', onClick: open('loose') },
    { separator: true },
    { label: '从本地文件上传', hint: '拖拽也可以', onClick: onUpload },
  ];
}
