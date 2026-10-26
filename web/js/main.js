import { LibraryView } from './views/library.js';
import { CharacterView } from './views/character.js';
import { PackView } from './views/pack.js';
import { UploadsView } from './views/uploads.js';
import { MediaView } from './views/media.js';
import { EmojiView } from './views/emoji.js';
import { ResourcesView } from './views/resources.js';
import { ResourceView } from './views/resource.js';
import { initUploadHud } from './components/upload-hud.js';

const app = document.getElementById('app');

const routes = [
  [/^\/$/, () => LibraryView(app, null)],
  [/^\/s\/(\d+)$/, (m) => LibraryView(app, Number(m[1]))],
  [/^\/c\/(\d+)$/, (m) => CharacterView(app, Number(m[1]))],
  [/^\/e\/(\d+)$/, (m) => EmojiView(app, Number(m[1]))],
  [/^\/rs\/(\d+)$/, (m) => ResourcesView(app, Number(m[1]))],
  [/^\/r\/(\d+)$/, (m) => ResourceView(app, Number(m[1]))],
  [/^\/p\/(\d+)$/, (m) => PackView(app, Number(m[1]))],
  [/^\/i\/(\d+)$/, (m) => MediaView(app, Number(m[1]))],
  [/^\/uploads$/, () => UploadsView(app)],
];

let busy = false;
let cleanup = null;
/** 上一次渲染的路径，用来在离开前把滚动位置存到它名下 */
let lastPath = null;

const scrollKeyOf = (p) => `cl-scroll:${p}`;

/** 列表页高度是 rAF 里排出来的，恢复要连着试几帧，否则会被浏览器夹到底部 */
function restoreScroll(path) {
  let want = 0;
  try {
    want = Number(sessionStorage.getItem(scrollKeyOf(path)) || 0);
  } catch {
    want = 0;
  }
  if (!want) {
    window.scrollTo(0, 0);
    return;
  }
  let tries = 0;
  const tick = () => {
    window.scrollTo(0, want);
    tries += 1;
    if (tries < 24 && Math.abs(window.scrollY - want) > 2) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function renderRoute() {
  if (busy) return;
  busy = true;
  // 路由只认路径，query 不能进 path（否则 /e/3?tab=all 匹配不到路由表）
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const here = path + location.search;
  if (lastPath) {
    try {
      sessionStorage.setItem(scrollKeyOf(lastPath), String(window.scrollY));
    } catch {
      /* 隐私模式写不了就算了 */
    }
  }

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
      if (!/^\/(c|p|i|e|r|rs)\/|^\/uploads/.test(path)) document.title = '资料库';
      lastPath = here;
      restoreScroll(here);
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
