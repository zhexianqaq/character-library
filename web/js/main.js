import { LibraryView } from './views/library.js';
import { CharacterView } from './views/character.js';
import { PackView } from './views/pack.js';
import { UploadsView } from './views/uploads.js';
import { MediaView } from './views/media.js';
import { EmojiView } from './views/emoji.js';
import { initUploadHud } from './components/upload-hud.js';

const app = document.getElementById('app');

const routes = [
  [/^\/$/, () => LibraryView(app, null)],
  [/^\/s\/(\d+)$/, (m) => LibraryView(app, Number(m[1]))],
  [/^\/c\/(\d+)$/, (m) => CharacterView(app, Number(m[1]))],
  [/^\/e\/(\d+)$/, (m) => EmojiView(app, Number(m[1]))],
  [/^\/p\/(\d+)$/, (m) => PackView(app, Number(m[1]))],
  [/^\/i\/(\d+)$/, (m) => MediaView(app, Number(m[1]))],
  [/^\/uploads$/, () => UploadsView(app)],
];

let busy = false;
let cleanup = null;

export async function renderRoute() {
  if (busy) return;
  busy = true;
  const path = location.pathname.replace(/\/+$/, '') || '/';

  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    try {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (err) {
          console.error(err);
        }
      }
      cleanup = null;
      app.innerHTML = '';
      const ret = await fn(m);
      if (typeof ret === 'function') cleanup = ret;
      if (!/^\/(c|p|i|e)\/|^\/uploads/.test(path)) document.title = '资料库';
      window.scrollTo(0, 0);
    } catch (err) {
      console.error(err);
      app.innerHTML = `<div class="empty"><b>页面加载失败</b>${String(err.message || err)}<br><a href="/" data-link style="text-decoration:underline">回资料库</a></div>`;
    } finally {
      busy = false;
    }
    return;
  }

  app.innerHTML = `<div class="empty"><b>页面不存在</b><a href="/" data-link style="text-decoration:underline">回资料库</a></div>`;
  busy = false;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('http')) return;
  e.preventDefault();
  if (href === location.pathname) return;
  history.pushState({}, '', href);
  renderRoute();
});

window.addEventListener('popstate', renderRoute);
window.addEventListener('app:route', renderRoute);

initUploadHud();
renderRoute();
