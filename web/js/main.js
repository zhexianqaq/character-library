import { LibraryView } from './views/library.js';
import { CharacterView } from './views/character.js';
import { PackView } from './views/pack.js';
import { UploadsView } from './views/uploads.js';
import { MediaView } from './views/media.js';
import { EmojiView } from './views/emoji.js';
import { InboxView } from './views/inbox.js';
import { NovelView } from './views/novel.js';
import { ResourcesView } from './views/resources.js';
import { ResourceView } from './views/resource.js';
import { ReaderView } from './views/reader.js';
import { ComicView } from './views/comic.js';
import { TagView } from './views/tag.js';
import { OpsView } from './views/ops.js';
import { initUploadHud } from './components/upload-hud.js';
import { installFindShortcut } from './components/topbar.js';

const app = document.getElementById('app');

const routes = [
  [/^\/$/, (_m, scope) => LibraryView(scope, null)],
  [/^\/s\/(\d+)$/, (m, scope) => LibraryView(scope, Number(m[1]))],
  [/^\/c\/(\d+)$/, (m, scope) => CharacterView(scope, Number(m[1]))],
  [/^\/e\/(\d+)$/, (m, scope) => EmojiView(scope, Number(m[1]))],
  [/^\/x\/(\d+)$/, (m, scope) => InboxView(scope, Number(m[1]))],
  [/^\/n\/(\d+)$/, (m, scope) => NovelView(scope, Number(m[1]))],
  [/^\/rs\/(\d+)$/, (m, scope) => ResourcesView(scope, Number(m[1]))],
  [/^\/r\/(\d+)$/, (m, scope) => ResourceView(scope, Number(m[1]))],
  [/^\/p\/(\d+)$/, (m, scope) => PackView(scope, Number(m[1]))],
  [/^\/i\/(\d+)$/, (m, scope) => MediaView(scope, Number(m[1]))],
  [/^\/read\/(\d+)$/, (m, scope) => ReaderView(scope, Number(m[1]))],
  [/^\/cm\/(\d+)$/, (m, scope) => ComicView(scope, Number(m[1]))],
  // 标签名里可能有空格 / # / 斜杠，整体 decode
  [/^\/tag\/(.+)$/, (m, scope) => TagView(scope, decodeURIComponent(m[1]))],
  [/^\/uploads$/, (_m, scope) => UploadsView(scope)],
  [/^\/ops$/, (_m, scope) => OpsView(scope)],
];

let busy = false;
let cleanup = null;
/** 上一次渲染的路径，用来在离开前把滚动位置存到它名下 */
let lastPath = null;

const scrollKeyOf = (p) => `cl-scroll:${p}`;

/** 把当前路径的滚动位置写进 sessionStorage */
function saveScroll() {
  if (!lastPath) return;
  try {
    sessionStorage.setItem(scrollKeyOf(lastPath), String(window.scrollY));
  } catch {
    /* 隐私模式写不了就算了 */
  }
}

/* 刷新 / 关标签页 / 切路由都要留位置。
   以前只在 renderRoute 开头存「上一个路径」—— F5 时新文档里 lastPath 还是空的，
   压根没人存当前位置，恢复时读到 0，于是刷新后一路弹回顶部（用户说的「自动滚动」）。
   pagehide 在刷新和关闭时一定会触发；滚动的节流副本用来兜进程被强杀的情况。 */
window.addEventListener('pagehide', saveScroll);
window.addEventListener('beforeunload', saveScroll);
let scrollSaveTimer = 0;
window.addEventListener(
  'scroll',
  () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveScroll, 220);
  },
  { passive: true }
);

/* 浏览器自带的历史滚动恢复会和我们抢：它在文档还只有几十像素高的时候就想跳，
   算出来是 0 或者被夹到底部。关掉它，位置完全由 restoreScroll 负责。 */
try {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
} catch {
  /* 老浏览器没有就算了 */
}

/**
 * 这一次渲染该不该回到上次的位置？
 *
 * 只有两种情况该回去：**整页重载**（F5，说明人刚才就站在那儿）和**前进 / 后退**
 * （回到刚看过的那一页）。点链接进来（pushState）一律从顶部开始 ——
 * 否则会出现「明明是从列表点进来的，一进去就停在上次看到的一半」。
 */
function initialShouldRestore() {
  try {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && nav.type) return nav.type === 'reload' || nav.type === 'back_forward';
    const t = performance.navigation && performance.navigation.type;
    return t === 1 || t === 2; // 1=reload 2=back_forward（老接口）
  } catch {
    return false;
  }
}
let wantRestore = initialShouldRestore();

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
    // rAF 里排版的列表要连着试几帧；给到 ~0.75s，慢页面也够
    if (tries < 45 && Math.abs(window.scrollY - want) > 2) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function renderRoute() {
  if (busy) return;
  busy = true;
  const shouldRestore = wantRestore;
  wantRestore = false;
  // 路由只认路径，query 不能进 path（否则 /e/3?tab=all 匹配不到路由表）
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const here = path + location.search;
  // 同一个页面原地重渲染（某些流程会再发一次 app:route）：位置不该被甩回顶部
  const sameRoute = here === lastPath;
  saveScroll(); // 离开当前路由前先把它滚到哪儿记下来

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
      /* 每次渲染换一个**新容器**再交给视图。
         视图里大量 root.addEventListener(...) 是挂在 root 上的；root 若是常驻的 #app，
         路由切换只清了 innerHTML，监听器与它捕获的闭包会一直留着 ——
         访问过的每个条目都叠一套，点简介时最先注册的那套先跑，于是把内容写到**上一个**
         条目上（v3.72 修：简介串人、别名弹窗一次弹好几个）。 */
      const scope = document.createElement('div');
      scope.className = 'route-scope';
      app.appendChild(scope);
      const ret = await fn(m, scope);
      if (typeof ret === 'function') cleanup = ret;
      if (!/^\/(c|p|i|e|r|rs|n|x|cm|read|tag)\/|^\/(uploads|ops)/.test(path)) document.title = '资料库';
      lastPath = here;
      if (shouldRestore || sameRoute) {
        restoreScroll(here);
      } else {
        // 点进来的：从头看。顺手把这一页记成 0，免得下次前进 / 后退又跳回旧位置
        try {
          sessionStorage.setItem(scrollKeyOf(here), '0');
        } catch {
          /* 忽略 */
        }
        window.scrollTo(0, 0);
      }
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
  wantRestore = false; // 点链接 = 新页面，从顶部开始
  renderRoute();
});

window.addEventListener('popstate', () => {
  wantRestore = true; // 前进 / 后退 = 回到刚看过的那一页，恢复位置
  renderRoute();
});
window.addEventListener('app:route', () => {
  wantRestore = false;
  renderRoute();
});

initUploadHud();
installFindShortcut();
renderRoute();
