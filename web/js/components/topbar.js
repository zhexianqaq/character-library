import { esc } from '../util.js';

export function topbarHtml({
  title = '资料库',
  sub = '角色库',
  search = false,
  back = false,
  actions = '',
  placeholder = '搜索角色',
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
             <input type="search" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" />
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
