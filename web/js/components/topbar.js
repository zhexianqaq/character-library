import { esc } from '../util.js';

export function topbarHtml({
  title = '资料库',
  sub = '角色集',
  search = false,
  back = false,
  actions = '',
  placeholder = '搜索角色',
  searchValue = '',
  searchKey = '',
} = {}) {
  return `<header class="topbar">
    ${back ? `<button class="tb-btn" data-back aria-label="返回">‹ 返回</button>` : ''}
    <div class="brand"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
    ${
      search
        ? `<label class="search">
             <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
               <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
             </svg>
             <input type="search" data-tb-search${searchKey ? ` data-search-key="${esc(searchKey)}"` : ''}
               placeholder="${esc(placeholder)}" value="${esc(searchValue)}"
               autocomplete="off" spellcheck="false" />
           </label>`
        : '<div style="flex:1"></div>'
    }
    ${actions}
  </header>`;
}

export function bindTopbar(root) {
  const back = root.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => history.back());
}

/**
 * 顶栏搜索框的统一接法：输入后按间隔回调（不重建顶栏，所以输入框不会失焦）。
 * root 可以是页面根，也可以是嵌在首页里的容器 —— 只要里面找得到那个 input。
 */
export function bindTopbarSearch(root, onQuery, { delay = 200 } = {}) {
  const input = root.querySelector('[data-tb-search]');
  if (!input) return () => {};
  let timer = 0;
  const fire = (immediate = false) => {
    clearTimeout(timer);
    if (immediate) {
      onQuery(input.value.trim());
      return;
    }
    timer = setTimeout(() => onQuery(input.value.trim()), delay);
  };
  const onInput = () => fire();
  // Esc 清空（type=search 自带的小叉在某些 WebView 里不显示）
  const onKey = (e) => {
    if (e.key !== 'Escape' || !input.value) return;
    e.preventDefault();
    e.stopPropagation();
    input.value = '';
    fire(true);
  };
  const onSearch = () => fire(true);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('search', onSearch);
  return () => {
    clearTimeout(timer);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('search', onSearch);
  };
}

/** 弹层开着的时候不抢焦点：搜索框在遮罩底下，聚焦了也看不见 */
const OVERLAY = '.modal[aria-modal="true"], .picker[aria-modal="true"], .lightbox';

/** 当前页面能用、且真的显示出来的搜索框（有些视图会渲染多个，取第一个可见的） */
function visibleSearch() {
  for (const el of document.querySelectorAll('[data-tb-search]')) {
    if (el.disabled || el.readOnly) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    const box = el.getBoundingClientRect();
    if (box.width > 4 && box.height > 4) return el;
  }
  return null;
}

/**
 * Ctrl+F / Cmd+F → 聚焦顶栏搜索框（已有内容则全选，直接打字就是替换）。
 *
 * 为什么值得拦：两种环境里浏览器的「查找」都不好用 ——
 *   - 桌面壳（WebView2）压根没有查找条，按下去什么都不会发生；
 *   - 网页版弹的是 Chrome 查找条，但瀑布流是分片渲染的，还没铺出来的卡片
 *     不在 DOM 里，它搜不到；而且它只滚动不筛选，跟这里的搜索不是一回事。
 *
 * 没有搜索框的页面（阅读器、漫画阅读、媒体详情、标签页…）不拦，
 * 交回浏览器 —— 那些地方对正文做查找仍然有意义。
 */
export function installFindShortcut() {
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key !== 'f' && e.key !== 'F') return;
    if (document.querySelector(OVERLAY)) return;
    const input = visibleSearch();
    if (!input) return;
    e.preventDefault();
    // preventScroll：顶栏是 sticky 的本来就看得见，别让焦点把页面顶上去
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    input.select();
  });
}
