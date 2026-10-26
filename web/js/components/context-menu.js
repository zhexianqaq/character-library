import { esc } from '../util.js';

let root = null;
let cleanup = null;

export function closeContextMenu() {
  if (!root) return;
  root.remove();
  root = null;
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

/**
 * 打开右键菜单。
 * items: [{ label, hint, danger, disabled, onClick } | { separator: true }]
 */
export function openContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();

  const list = (items || []).filter(Boolean);
  if (!list.length) return;

  root = document.createElement('div');
  root.className = 'ctx-menu';
  root.setAttribute('role', 'menu');
  root.innerHTML = list
    .map((it, i) => {
      if (it.separator) return '<div class="ctx-sep"></div>';
      return `<button class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}" role="menuitem" ${
        it.disabled ? 'disabled' : ''
      }>
        <span>${esc(it.label)}</span>${it.hint ? `<em>${esc(it.hint)}</em>` : ''}
      </button>`;
    })
    .join('');
  document.body.appendChild(root);

  // 贴住鼠标位置，超出视口就翻转
  const pad = 8;
  const box = root.getBoundingClientRect();
  let x = event.clientX;
  let y = event.clientY;
  if (x + box.width + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - box.width - pad);
  if (y + box.height + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - box.height - pad);
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;

  root.querySelectorAll('.ctx-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = list[Number(btn.dataset.i)];
      closeContextMenu();
      if (it && typeof it.onClick === 'function') it.onClick();
    });
  });

  const onDown = (e) => {
    if (!root || !root.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeContextMenu();
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);
  cleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', closeContextMenu, true);
    window.removeEventListener('resize', closeContextMenu);
  };

  requestAnimationFrame(() => {
    if (root) root.classList.add('show');
  });
}

/** 给某个容器挂右键：handler 返回菜单项数组，返回空则不弹出 */
export function bindContextMenu(container, handler) {
  if (!container) return;
  container.addEventListener('contextmenu', (e) => {
    const items = handler(e);
    if (items && items.length) openContextMenu(e, items);
    else e.preventDefault();
  });
}
