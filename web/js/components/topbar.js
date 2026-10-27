import { esc } from '../util.js';

export function topbarHtml({
  title = '资料库',
  sub = '角色库',
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
