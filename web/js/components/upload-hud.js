import { queue } from '../upload-queue.js';

let inited = false;

/**
 * 右下角的常驻上传指示：有任务时出现，点开就是上传队列页。
 * 全局只建一次，订阅队列；上传页里自动隐身（那页本身就在显示进度）。
 */
export function initUploadHud() {
  if (inited || !document.body) return;
  inited = true;

  const el = document.createElement('button');
  el.className = 'up-hud';
  el.hidden = true;
  el.type = 'button';
  el.innerHTML = `<span class="up-hud-track"><i></i></span><span class="up-hud-txt"></span>`;
  document.body.appendChild(el);

  const bar = el.querySelector('.up-hud-track i');
  const txt = el.querySelector('.up-hud-txt');
  let hideTimer = 0;

  const goto = () => {
    if (location.pathname === '/uploads') return;
    history.pushState({}, '', '/uploads');
    window.dispatchEvent(new CustomEvent('app:route'));
  };
  el.addEventListener('click', goto);

  queue.subscribe((s) => {
    const onPage = location.pathname === '/uploads';
    if (s.active > 0) {
      clearTimeout(hideTimer);
      el.hidden = onPage;
      el.classList.remove('is-done');
      el.classList.toggle('is-err', s.failed > 0);
      bar.style.width = `${Math.round(s.percent * 100)}%`;
      const p = Math.round(s.percent * 100);
      txt.textContent = `上传中 ${p}% · ${s.finished}/${s.total}`;
      return;
    }
    // 刚传完：停 3 秒给个结果，再收起来
    if (s.total && !onPage) {
      clearTimeout(hideTimer);
      el.hidden = false;
      el.classList.add('is-done');
      el.classList.toggle('is-err', s.failed > 0);
      bar.style.width = '100%';
      txt.textContent = s.failed ? `${s.failed} 个失败 · 点击查看` : `已完成 ${s.done} 项`;
      hideTimer = setTimeout(() => {
        el.hidden = true;
      }, 3400);
      return;
    }
    el.hidden = true;
  });

  // 路由切换后重新判断（比如刚进上传页要隐身）
  window.addEventListener('app:route', () => {
    const s = queue.list().length;
    if (!s) el.hidden = true;
    else if (location.pathname === '/uploads') el.hidden = true;
  });
}
