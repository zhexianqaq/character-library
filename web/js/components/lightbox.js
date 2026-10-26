import { api } from '../api.js';
import { esc, fmtDur } from '../util.js';
import { pushEsc } from '../esc.js';

let active = null;

export function closeLightbox() {
  if (!active) return;
  active.root.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', active.onKey);
  if (active.offEsc) active.offEsc();
  active = null;
}

export function openLightbox(items, startIndex = 0, opts = {}) {
  closeLightbox();
  if (!items || !items.length) return;

  const list = items.filter((it) => it.kind === 'image' || it.kind === 'video');
  if (!list.length) return;

  let idx = Math.max(0, Math.min(startIndex, list.length - 1));

  const root = document.createElement('div');
  root.className = 'lightbox';
  root.innerHTML = `
    <div class="lb-bar">
      <span class="count"></span>
      <span class="name"></span>
      <span class="lb-tags"></span>
      <button class="close" title="关闭 (Esc)" aria-label="关闭">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M3 3l10 10M13 3L3 13"/>
        </svg>
      </button>
    </div>
    <div class="lb-stage">
      <button class="lb-nav prev" aria-label="上一张">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>
      </button>
      <button class="lb-nav next" aria-label="下一张">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>
      </button>
    </div>`;

  const stage = root.querySelector('.lb-stage');
  const countEl = root.querySelector('.lb-bar .count');
  const nameEl = root.querySelector('.lb-bar .name');
  const tagsEl = root.querySelector('.lb-bar .lb-tags');
  const prevBtn = root.querySelector('.lb-nav.prev');
  const nextBtn = root.querySelector('.lb-nav.next');

  const preload = (i) => {
    const it = list[i];
    if (!it || it.kind !== 'image') return;
    const img = new Image();
    img.src = api.preview(it.id);
  };

  const render = () => {
    const it = list[idx];
    countEl.textContent = `${idx + 1} / ${list.length}`;
    nameEl.textContent = it.fileName || '';
    const tags = Array.isArray(it.tags) ? it.tags : [];
    tagsEl.innerHTML = tags.map((t) => `<i>${esc(t)}</i>`).join('');
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === list.length - 1;
    stage.querySelectorAll('img, video').forEach((n) => n.remove());

    if (it.kind === 'video') {
      const v = document.createElement('video');
      v.src = api.original(it.id);
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.preload = 'metadata';
      stage.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = api.preview(it.id);
      img.alt = it.fileName || '';
      stage.appendChild(img);
      // 先给 1280 预览图，再无缝换成原图
      const hi = new Image();
      hi.onload = () => {
        if (list[idx] === it && img.isConnected) img.src = hi.src;
      };
      hi.src = api.original(it.id);
    }
    preload(idx + 1);
    preload(idx - 1);
  };

  const go = (delta) => {
    const next = idx + delta;
    if (next < 0 || next >= list.length) return;
    idx = next;
    render();
  };

  const onKey = (e) => {
    // Esc 交给 esc 栈；这里只留左右翻页
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    }
  };

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));
  root.querySelector('.lb-bar .close').addEventListener('click', closeLightbox);
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target === stage) closeLightbox();
  });

  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(root);

  active = { root, onKey, offEsc: pushEsc(() => closeLightbox(), () => !!active) };
  render();
  if (opts.onChange) opts.onChange(idx);
}
