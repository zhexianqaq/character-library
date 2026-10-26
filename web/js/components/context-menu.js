import { esc } from '../util.js';
import { pushEsc } from '../esc.js';

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
 * items: [{ label, hint, danger, disabled, onClick, children } | { separator: true }]
 * children 会展开成下一级菜单（点父项后在同一位置替换显示）。
 */
export function openContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  openMenuAt(event.clientX, event.clientY, items);
}

/** 没有鼠标事件时用（比如点按钮弹菜单），传视口坐标 */
export function openMenuAtPoint(x, y, items) {
  openMenuAt(x, y, items);
}

function openMenuAt(clientX, clientY, items) {
  closeContextMenu();

  const list = (items || []).filter(Boolean);
  if (!list.length) return;

  root = document.createElement('div');
  root.className = 'ctx-menu';
  root.setAttribute('role', 'menu');
  root.innerHTML = list
    .map((it, i) => {
      if (it.separator) return '<div class="ctx-sep"></div>';
      const sub = Array.isArray(it.children) && it.children.length;
      return `<button class="ctx-item${it.danger ? ' danger' : ''}${sub ? ' has-sub' : ''}" data-i="${i}" role="menuitem" ${
        it.disabled ? 'disabled' : ''
      }>
        <span>${esc(it.label)}</span>${it.hint ? `<em>${esc(it.hint)}</em>` : ''}${sub ? '<i>›</i>' : ''}
      </button>`;
    })
    .join('');
  document.body.appendChild(root);

  // 贴住鼠标位置，超出视口就翻转
  const pad = 8;
  const box = root.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + box.width + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - box.width - pad);
  if (y + box.height + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - box.height - pad);
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;

  root.querySelectorAll('.ctx-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = list[Number(btn.dataset.i)];
      if (!it) return;
      if (Array.isArray(it.children) && it.children.length) {
        openMenuAt(x, y, it.children);
        return;
      }
      closeContextMenu();
      if (typeof it.onClick === 'function') it.onClick();
    });
  });

  const onDown = (e) => {
    if (!root || !root.contains(e.target)) closeContextMenu();
  };
  document.addEventListener('mousedown', onDown, true);
  // Esc 交给 esc 栈：菜单在最上层时只关菜单，不会连带关掉下面的弹窗
  const offEsc = pushEsc(() => closeContextMenu(), () => !!root);
  window.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);
  cleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    offEsc();
    window.removeEventListener('scroll', closeContextMenu, true);
    window.removeEventListener('resize', closeContextMenu);
  };

  requestAnimationFrame(() => {
    if (!root) return;
    // 首帧测量可能因为内容换行/字体度量偏小，显示前再校一次，防止贴着右边缘被裁
    const b = root.getBoundingClientRect();
    let nx = parseFloat(root.style.left) || 0;
    let ny = parseFloat(root.style.top) || 0;
    if (nx + b.width + pad > window.innerWidth) nx = Math.max(pad, window.innerWidth - b.width - pad);
    if (ny + b.height + pad > window.innerHeight) ny = Math.max(pad, window.innerHeight - b.height - pad);
    root.style.left = `${nx}px`;
    root.style.top = `${ny}px`;
    root.classList.add('show');
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
