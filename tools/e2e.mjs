/**
 * 端到端测试：用真实 Chrome 跑一遍关键流程。
 * 用法：node tools/e2e.mjs
 * 前置：服务已在 http://127.0.0.1:7788 运行
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.BASE || 'http://127.0.0.1:7788';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WIDTH = 1440;
const HEIGHT = 900;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9500 + Math.floor(Math.random() * 300);
const profile = path.join(os.tmpdir(), `cl-e2e-${Date.now()}`);
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    '--hide-scrollbars',
    '--disable-extensions',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function wsUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 等待 */
    }
    await sleep(120);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const url = await wsUrl();
const ws = new WebSocket(url);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本报错');
  }
  return r.result.value;
}

/** 轮询直到条件满足，避免「固定 sleep 撞上冷启动」造成的假失败 */
async function waitFor(expression, ok, timeoutMs = 15000, interval = 300) {
  const t0 = Date.now();
  let value;
  for (;;) {
    value = await evaluate(expression);
    if (ok(value)) return { ok: true, value, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, value, ms: Date.now() - t0 };
    await sleep(interval);
  }
}

/** 真实鼠标点击：合成 .click() 不会移动焦点，测不出「点完残留」这类问题 */
async function realClick(selector) {
  const p = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (!p) return false;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' });
  // 无头模式不产帧就不推进 CSS 过渡，抓一张图强制渲染
  await send('Page.captureScreenshot', { format: 'png' });
  await sleep(350);
  return true;
}

/** 真实右键（合成事件不会触发浏览器 contextmenu 的默认派发路径） */
async function realRightClick(selector) {
  const p = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (!p) return false;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await send('Page.captureScreenshot', { format: 'png' });
  await sleep(350);
  return true;
}

/** 右键后读出菜单文字，然后关掉 */
async function readMenuAndClose() {
  const labels = await evaluate(`[...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => b.querySelector('span').textContent.trim())`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(250);
  return labels;
}

async function goto(url2, wait = 1400) {
  await send('Page.navigate', { url: url2 });
  await sleep(wait);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

console.log(`\n端到端测试  ${BASE}\n`);

try {
  // 1. 首页
  await goto(`${BASE}/`);
  const cardCount = await evaluate(`document.querySelectorAll('.char-card').length`);
  check('首页渲染角色卡片', cardCount >= 1, `${cardCount} 张`);

  // 1.4 右键角色卡
  if (await realRightClick('.char-card')) {
    const labels = await readMenuAndClose();
    check(
      '右键角色卡出现条目菜单',
      labels.includes('编辑名称') && labels.includes('删除') && labels.includes('打开本地文件夹'),
      labels.join(' / ')
    );
  }

  // 1.5 多库：每个库独立统计，切换会改 URL
  const shelves = await evaluate(`(() => fetch('/api/overview')
    .then((r) => r.json())
    .then((o) => o.shelves.map((s) => ({ id: s.id, name: s.name, bytes: s.bytes, chars: s.characterCount }))))()`);
  check(
    '每个库都有独立的角色数与占用',
    shelves.length > 0 && shelves.every((x) => typeof x.bytes === 'number' && typeof x.chars === 'number'),
    shelves.map((x) => `${x.name}(${x.chars}人/${Math.round(x.bytes / 1048576)}MB)`).join(' / ')
  );
  if (shelves.length > 1) {
    const tabCount = await evaluate(`document.querySelectorAll('[data-shelf]').length`);
    check('库标签数量与接口一致', tabCount === shelves.length, `${tabCount} 个标签`);
    const last = shelves[shelves.length - 1];
    await evaluate(`document.querySelector('[data-shelf="${last.id}"]').click()`);
    await sleep(1200);
    const after = await evaluate(`({
      path: location.pathname,
      active: document.querySelector('[data-shelf].on')?.dataset.shelf || '',
    })`);
    check(
      '切换库会更新 URL',
      after.path === `/s/${last.id}` && after.active === String(last.id),
      JSON.stringify(after)
    );
    // 切回第一个库，后面的用例依赖角色列表
    await evaluate(`document.querySelector('[data-shelf="${shelves[0].id}"]').click()`);
    await sleep(1200);
  }

  const cssLoaded = await evaluate(
    `getComputedStyle(document.querySelector('.topbar')).position === 'sticky'`
  );
  check('样式表已加载', cssLoaded === true);

  // 防缓存回归：首页必须以版本前缀加载入口资源，否则模块会新旧混搭
  const versioned = await evaluate(`
    (() => {
      const s = document.querySelector('script[src*="main.js"]');
      const l = document.querySelector('link[href*="app.css"]');
      const ok = (u) => /\\/a\\/[a-z0-9]+\\//i.test(u || '');
      return Boolean(s && ok(s.getAttribute('src')) && l && ok(l.getAttribute('href')));
    })()
  `);
  check('首页资源带版本前缀（防缓存混搭）', versioned === true);

  // 模块必须真的能加载：随便 import 一个深层模块，缺导出会在这里暴露
  const modOk = await evaluate(`
    import('/a/' + (document.querySelector('script[src*="main.js"]').getAttribute('src').split('/')[2]) + '/js/api.js')
      .then(m => typeof m.uploadMedia === 'function')
      .catch(() => false)
  `);
  check('api.js 导出了 uploadMedia（模块完整）', modOk === true);

  // 2. 角色详情
  // 点一个真正有内容的角色（首页可能还有刚建的测试角色）
  await evaluate(`
    (() => {
      const cards = [...document.querySelectorAll('.char-card')];
      const num = (c) => Number((c.querySelector('.badge')?.textContent || '0').replace(/[^0-9]/g, ''));
      cards.sort((a, b) => num(b) - num(a));
      cards[0].click();
    })()
  `);
  await sleep(1600);
  const heroName = await evaluate(`document.querySelector('.hero-name')?.textContent?.trim() || ''`);
  check('进入角色详情页', !!heroName, heroName);
  check('URL 变为 /c/:id', /^\/c\/\d+$/.test(await evaluate('location.pathname')));

  // 2.5 平台账号：有网址跳转、没网址复制；新增弹窗三段式
  const pf = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.pf-card')];
    const noUrl = cards.find((c) => !c.dataset.url);
    return {
      count: cards.length,
      withUrl: cards.filter((c) => c.dataset.url).length,
      hasLinkMark: cards.some((c) => c.querySelector('.pf-link')),
      noUrlHandle: noUrl ? noUrl.dataset.handle : '',
    };
  })()`);

  if (pf.count > 0) {
    check(
      '有网址的平台卡片带跳转标记',
      pf.withUrl === 0 || pf.hasLinkMark === true,
      `${pf.count} 个平台 / ${pf.withUrl} 个带网址`
    );
    if (pf.noUrlHandle) {
      await evaluate(`([...document.querySelectorAll('.pf-card')].find((c) => !c.dataset.url)).click()`);
      await sleep(600);
      const copyToast = await evaluate(`document.querySelector('#toast')?.textContent || ''`);
      check('点击无网址的卡片复制 ID', /已复制/.test(copyToast), copyToast);
    }

    await evaluate(`document.querySelector('[data-add-platform]').click()`);
    await sleep(400);
    const shape = await evaluate(`(() => {
      const m = document.querySelector('.modal');
      if (!m) return null;
      const plat = m.querySelector('[name=platform]');
      const dl = plat && plat.getAttribute('list');
      return {
        platform: !!plat,
        options: dl ? document.querySelectorAll('#' + dl + ' option').length : 0,
        handle: !!m.querySelector('[name=handle]'),
        url: !!m.querySelector('[name=url]'),
        rows: m.querySelectorAll('.field-row').length,
      };
    })()`);
    check(
      '添加平台弹窗 = 下拉 + ID + 网址',
      !!shape && shape.platform && shape.handle && shape.url && shape.options > 5 && shape.rows === 1,
      JSON.stringify(shape)
    );
    await evaluate(`document.querySelector('.modal [data-cancel]').click()`);
    await sleep(300);

    // 回归：真实点击卡片后，✎✕ 不能粘在卡片上（曾因 :focus-within 残留灰色块）
    if (pf.noUrlHandle && (await realClick('.pf-card[data-url=""]'))) {
      const residual = await evaluate(`(() => {
        const c = document.querySelector('.pf-card[data-url=""]');
        return {
          focusWithin: c.matches(':focus-within'),
          opacity: getComputedStyle(c.querySelector('.pf-acts')).opacity,
        };
      })()`);
      check('点击平台卡片后动作按钮不残留', residual.opacity === '0', JSON.stringify(residual));
    }
  } else {
    check('平台账号功能', true, '当前角色无平台账号，跳过');
  }

  // 2.6 标签：媒体继承 + 弹窗查重/相似校验
  const tagPool = await evaluate(`fetch('/api/tags').then((r) => r.json()).then((d) => d.items)`);
  check('标签接口可用', Array.isArray(tagPool), `${tagPool.length} 个标签`);

  const mediaTags = await evaluate(`fetch('/api/characters/' + location.pathname.split('/').pop() + '/media')
    .then((r) => r.json())
    .then((d) => (d.items[0] ? d.items[0].tags : []))`);
  check(
    '媒体自动带上角色标签和库标签',
    mediaTags.length >= 2 && mediaTags.includes('人物'),
    JSON.stringify(mediaTags)
  );

  await evaluate(`document.querySelector('[data-add-tag]').click()`);
  await sleep(700);
  const picker = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const input = q('.tag-input');
    const out = {};
    input.value = 'E2E标签';
    q('[data-add]').click();
    out.added = [...document.querySelectorAll('.tag-pill')].some((b) => b.dataset.tag === 'E2E标签');
    input.value = 'E2E标签';
    q('[data-add]').click();
    out.dupHint = q('[data-hint]').textContent.trim();
    out.dupCount = [...document.querySelectorAll('.tag-pill')].filter((b) => b.dataset.tag === 'E2E标签').length;
    input.value = 'E2E标签cos';
    q('[data-add]').click();
    out.simHint = q('[data-hint]').textContent.trim();
    return out;
  })()`);
  check('标签弹窗能加新标签', picker.added === true);
  check('重复标签被拦下并提示', /已经有/.test(picker.dupHint) && picker.dupCount === 1, picker.dupHint);
  check('相似标签会先提醒', /很像/.test(picker.simHint), picker.simHint);
  await evaluate(`document.querySelector('.tag-modal [data-cancel]').click()`);
  await sleep(300);

  // 3. 图包网格
  const packCount = await evaluate(`document.querySelectorAll('.pack-card').length`);
  check('图包按月渲染', packCount > 0, `${packCount} 个`);

  // 2.7 右键图包
  if (await realRightClick('.pack-card')) {
    const labels = await readMenuAndClose();
    check(
      '右键图包出现图包菜单',
      labels.includes('编辑标签') && labels.includes('解散图包') && labels.includes('添加素材'),
      labels.join(' / ')
    );
  }

  // 2.8 「添加素材」展开四个来源
  if (await realRightClick('.pack-card')) {
    const sub = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const add = [...document.querySelectorAll('.ctx-menu .ctx-item')]
        .find(b => b.querySelector('span').textContent.trim() === '添加素材');
      if (!add) return null;
      add.click();
      await sleep(220);
      return [...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => b.querySelector('span').textContent.trim());
    })()`);
    check(
      '添加素材有四个来源',
      Array.isArray(sub) && sub.length === 4,
      Array.isArray(sub) ? sub.join(' / ') : String(sub)
    );
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(200);
  }

  // 2.9 素材选择器：范围切换 + 多选计数（只读，不落库）
  const mediaPicker = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const btn = document.querySelector('[data-add-media]');
    if (!btn) return { open: false };
    btn.click();
    await sleep(220);
    const item = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(b => b.querySelector('span').textContent.includes('从本角色素材添加'));
    item.click();
    await sleep(1800);
    const out = {
      open: !!document.querySelector('.picker'),
      scopes: [...document.querySelectorAll('.pk-scope button')].map(b => b.textContent.trim()),
      cells: document.querySelectorAll('.pk-cell').length,
    };
    const cell = document.querySelector('.pk-cell:not(.is-in)');
    if (cell) cell.click();
    await sleep(200);
    out.count = document.querySelector('[data-count]').textContent.replace(/\\s+/g, ' ').trim();
    out.okText = document.querySelector('[data-ok]').textContent.trim();
    document.querySelector('[data-cancel]').click();
    await sleep(200);
    out.closed = !document.querySelector('.picker');
    return out;
  })()`);
  check('素材选择器能打开', mediaPicker.open === true, `${mediaPicker.cells || 0} 个格子`);
  check(
    '选择器有四个范围',
    Array.isArray(mediaPicker.scopes) && mediaPicker.scopes.length === 4,
    (mediaPicker.scopes || []).join(' / ')
  );
  check('选中后底部显示已选数量', /已选\s*1\s*项/.test(mediaPicker.count || ''), mediaPicker.count);
  check('取消后选择器关闭', mediaPicker.closed === true);

  // 4. 切到全部媒体（瀑布流在 rAF 里画，轮询等它出来，别用固定 sleep）
  await evaluate(`document.querySelector('[data-view] button[data-v="media"]').click()`);
  let tiles = 0;
  for (let i = 0; i < 24; i += 1) {
    tiles = await evaluate(`document.querySelectorAll('.tile').length`);
    if (tiles) break;
    await sleep(300);
  }
  check('全部媒体瀑布流', tiles > 0, `${tiles} 个 tile`);

  const imgOk = await evaluate(`
    (() => {
      const imgs = [...document.querySelectorAll('.tile img')];
      return imgs.filter(i => i.naturalWidth > 0).length;
    })()
  `);
  check('缩略图实际加载出像素', imgOk > 0, `${imgOk}/${tiles} 张有内容`);

  // 5. 媒体详情页
  await evaluate(`document.querySelector('.tile').click()`);
  let detailPath = '';
  for (let i = 0; i < 24; i += 1) {
    detailPath = await evaluate(`location.pathname`);
    if (/^\/i\/\d+$/.test(detailPath)) break;
    await sleep(250);
  }
  check('点瓦片进入媒体详情页', /^\/i\/\d+$/.test(detailPath), detailPath);

  let detail = {};
  for (let i = 0; i < 20; i += 1) {
    detail = await evaluate(`({
      img: document.querySelector('.mp-canvas img')?.naturalWidth || 0,
      title: document.querySelector('.mp-title')?.textContent.trim() || '',
      rows: [...document.querySelectorAll('.mp-row > span')].map(s => s.textContent.trim()),
      tags: [...document.querySelectorAll('[data-tags] .mp-pill')].map(b => b.textContent.trim()),
      intro: document.querySelector('[data-intro]')?.textContent.trim() || '',
      place: document.querySelector('.mp-row b.mp-wrap')?.textContent.trim() || ''
    })`);
    if (detail.img > 0 && detail.rows.length) break;
    await sleep(300);
  }
  check('详情页大图加载出像素', detail.img > 0, `${detail.img}px 宽`);
  check(
    '详情页字段齐全',
    ['分辨率', '标签', '内容介绍', '关联', '存储位置', '存储大小', '存储时间'].every((k) => detail.rows.includes(k)),
    detail.rows.join(' / ')
  );
  check('详情页标签含条目名', (detail.tags || []).includes('纸悦'), (detail.tags || []).join(' '));
  check('详情页有介绍文案', (detail.intro || '').length > 4, detail.intro);
  check('存储位置带上库 / 条目 / 图包', /人物库.*纸悦/.test(detail.place || ''), detail.place);

  // 点图片进灯箱，Esc 只关灯箱、不退出详情页
  await evaluate(`document.querySelector('.mp-canvas img').click()`);
  await sleep(1500);
  check('详情页点图片打开灯箱', (await evaluate(`!!document.querySelector('.lightbox')`)) === true);
  check('灯箱内大图有像素', (await evaluate(`document.querySelector('.lightbox img')?.naturalWidth || 0`)) > 0);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check('Esc 关灯箱后仍停在详情页', (await evaluate(`!!document.querySelector('.lightbox')`)) === false
    && /^\/i\//.test(await evaluate(`location.pathname`)));

  await evaluate(`document.querySelector('[data-close]').click()`);
  await sleep(700);
  check('关闭详情页回到角色页', /^\/c\//.test(await evaluate(`location.pathname`)), await evaluate(`location.pathname`));
  await evaluate(`document.querySelector('[data-view] button[data-v="packs"]').click()`);
  await sleep(1200);

  // 6. 平台栏：超过 4 条时不拉高、内部滚动、底部有阴影、ID 左对齐
  const tmpId = await evaluate(`
    (async () => {
      const r = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '平台溢出验证', shelfId: 1 }),
      });
      const mk = await r.json();
      const many = ['推特 / X', '微博', '哔哩哔哩', '抖音', '小红书', 'Instagram'].map((p, i) => ({
        platform: p,
        handle: 'id_' + i,
        url: '',
      }));
      await fetch('/api/characters/' + mk.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: many }),
      });
      return mk.id;
    })()
  `);
  await goto(`${BASE}/c/${tmpId}`, 1800);
  const overflow = await evaluate(`
    (() => {
      const pane = document.querySelector('.platform-pane');
      const list = pane && pane.querySelector('.pf-list');
      if (!list) return null;
      const xs = [...list.querySelectorAll('.pf-handle')].map((e) => Math.round(e.getBoundingClientRect().x));
      return {
        count: list.querySelectorAll('.pf-card').length,
        listH: Math.round(list.getBoundingClientRect().height),
        scrollH: list.scrollHeight,
        hasMore: pane.classList.contains('has-more'),
        scrollbar: getComputedStyle(list).scrollbarWidth,
        aligned: new Set(xs).size === 1,
      };
    })()
  `);
  check(
    '平台超过 4 条时栏高封顶、内部滚动',
    !!overflow && overflow.count === 6 && overflow.listH === 132 && overflow.scrollH > overflow.listH,
    JSON.stringify(overflow)
  );
  check('平台可滚动时出现底部阴影', !!overflow && overflow.hasMore === true);
  check('平台列表无滚动条', !!overflow && overflow.scrollbar === 'none');
  check('平台 ID 左边缘对齐', !!overflow && overflow.aligned === true);
  await evaluate(`fetch('/api/characters/${tmpId}', { method: 'DELETE' })`);

  // 6.5 虚拟角色库：那一栏改成「出处」，弹窗是「出处类型 + 作品名」
  const workId = await evaluate(`
    (async () => {
      const ov = await (await fetch('/api/overview')).json();
      const work = ov.shelves.find((s) => s.kind === 'work');
      if (!work) return null;
      const mk = await (await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '出处验证', shelfId: work.id }),
      })).json();
      await fetch('/api/characters/' + mk.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: [{ platform: '游戏', handle: '原神', url: '' }] }),
      });
      // 三个小库各建一个图包，验证层级
      for (const cat of ['官图', 'cosplay', '同人']) {
        await fetch('/api/characters/' + mk.id + '/packs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: cat + '包', category: cat }),
        });
      }
      return mk.id;
    })()
  `);
  if (workId) {
    await goto(`${BASE}/c/${workId}`, 1800);
    const workPane = await evaluate(`(() => {
      const pane = document.querySelector('.platform-pane');
      const card = pane && pane.querySelector('.pf-card');
      return {
        head: pane ? pane.querySelector('.pf-head > span').textContent.trim() : '',
        card: card ? card.textContent.replace(/\s+/g, ' ').trim() : '',
        newBtn: document.querySelector('[data-new-char]') ? '角色页' : '',
      };
    })()`);
    check(
      '虚拟角色库显示「出处」而不是「平台」',
      workPane.head === '出处' && workPane.card.includes('原神') && workPane.card.includes('游戏'),
      JSON.stringify(workPane)
    );

    await evaluate(`document.querySelector('[data-add-platform]').click()`);
    await sleep(400);
    const workModal = await evaluate(`(() => {
      const m = document.querySelector('.modal');
      if (!m) return null;
      const plat = m.querySelector('[name=platform]');
      const dl = plat && plat.getAttribute('list');
      return {
        title: m.querySelector('h3').textContent,
        label: m.querySelector('.field > span').textContent.trim(),
        options: dl ? [...document.querySelectorAll('#' + dl + ' option')].map((o) => o.value) : [],
      };
    })()`);
    check(
      '出处弹窗是「类型 + 作品名」',
      !!workModal && workModal.title === '添加出处' && workModal.label.startsWith('出处类型') && workModal.options.includes('动画'),
      JSON.stringify(workModal)
    );
    await evaluate(`document.querySelector('.modal [data-cancel]').click()`);
    await sleep(200);

    // 小库：三个分类 + 按分类过滤图包
    const catTabs = await evaluate(`[...document.querySelectorAll('.cat')].map((b) => b.dataset.cat)`);
    check(
      '角色页出现 官图 / cosplay / 同人 三个小库',
      catTabs.join(',') === '官图,cosplay,同人',
      catTabs.join(' / ')
    );
    const firstCat = await evaluate(`({
      on: document.querySelector('.cat.on')?.dataset.cat || '',
      packs: [...document.querySelectorAll('.pack-card .t')].map((e) => e.textContent.trim()),
    })`);
    check(
      '默认只看「官图」，且只显示该小库的图包',
      firstCat.on === '官图' && firstCat.packs.join() === '官图包',
      JSON.stringify(firstCat)
    );
    await evaluate(`document.querySelector('[data-cat="cosplay"]').click()`);
    await sleep(900);
    const afterCat = await evaluate(`({
      on: document.querySelector('.cat.on')?.dataset.cat || '',
      packs: [...document.querySelectorAll('.pack-card .t')].map((e) => e.textContent.trim()),
    })`);
    check(
      '切到 cosplay 只显示 cosplay 的图包',
      afterCat.on === 'cosplay' && afterCat.packs.join() === 'cosplay包',
      JSON.stringify(afterCat)
    );

    await evaluate(`fetch('/api/characters/${workId}', { method: 'DELETE' })`);
  } else {
    check('虚拟角色库', true, '没有 work 类型的库，跳过');
  }

  // 7. 新建角色
  await goto(`${BASE}/`);
  await evaluate(`document.querySelector('[data-new-char]').click()`);
  await sleep(500);
  check('新建角色弹窗打开', (await evaluate(`!!document.querySelector('.modal')`)) === true);

  await evaluate(`
    (() => {
      const m = document.querySelector('.modal');
      m.querySelector('[name=name]').value = 'E2E 测试角色';
      m.querySelector('[name=account]').value = 'e2e_bot';
      m.querySelector('[data-ok]').click();
      return true;
    })()
  `);
  await sleep(1800);
  const newPath = await evaluate('location.pathname');
  check('提交后进入新角色页', /^\/c\/\d+$/.test(newPath), newPath);
  const newName = await evaluate(`document.querySelector('.hero-name')?.textContent?.trim() || ''`);
  check('新角色名正确', newName === 'E2E 测试角色', newName);

  // 7. 上传（内存生成图片，文件名带日期 -> 应自动归月包）
  await evaluate(`
    (async () => {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 800;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#8fb8d8'; ctx.fillRect(0, 0, 600, 800);
      ctx.fillStyle = '#ffffff'; ctx.font = '56px sans-serif';
      ctx.fillText('E2E', 48, 96);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const file = new File([blob], 'e2e-20250315-sample.png', { type: 'image/png' });
      // 上传输入框是按需创建的：先点「上传」，再取它
      document.querySelector('[data-upload]').click();
      await new Promise((r) => setTimeout(r, 250));
      const input = document.querySelector('input[type=file]');
      if (!input) return 'no-input';
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const packWait = await waitFor(
    `[...document.querySelectorAll('.pack-card .t')].map((e) => e.textContent.trim())`,
    (v) => v.some((t) => t.includes('2025 年 3 月'))
  );
  const uploadToast = await evaluate(`document.querySelector('#toast')?.textContent || ''`);
  check(
    '上传后按文件名日期建出 2025 年 3 月图包',
    packWait.ok,
    packWait.ok
      ? `${packWait.value.join(' / ')}（${packWait.ms}ms）`
      : `等了 ${packWait.ms}ms 没出现（toast: ${uploadToast || '空'}）`
  );

  const statWait = await waitFor(`document.querySelector('.stat b')?.textContent || ''`, (v) => v === '1');
  check('角色统计已刷新', statWait.ok, `图片数 = ${statWait.value}（${statWait.ms}ms）`);

  // 7.5 新建图包：日期非必填，只填名称也能建
  await evaluate(`document.querySelector('[data-new-pack]').click()`);
  await sleep(500);
  const packModal = await evaluate(`
    (() => {
      const m = document.querySelector('.modal');
      if (!m) return null;
      const monthLabel = [...m.querySelectorAll('.field > span')].find(s => s.textContent.includes('日期'));
      return {
        open: true,
        monthRequired: monthLabel ? monthLabel.textContent.includes('*') : true,
        monthType: m.querySelector('[name=month]')?.type || '',
      };
    })()
  `);
  check('新建图包弹窗打开', packModal && packModal.open === true);
  check('日期字段不是必填', packModal && packModal.monthRequired === false);

  await evaluate(`
    (() => {
      const m = document.querySelector('.modal');
      m.querySelector('[name=title]').value = 'E2E 自定义包';
      m.querySelector('[data-ok]').click();
      return true;
    })()
  `);
  await sleep(1600);
  const titlesAfter = await evaluate(`[...document.querySelectorAll('.pack-card .t')].map(e => e.textContent.trim())`);
  check('只填名称也能建图包', titlesAfter.includes('E2E 自定义包'), titlesAfter.join(' / '));

  // 8. 图包页
  await evaluate(`document.querySelector('.pack-hit')?.click()`);
  await sleep(2500);
  check('进入图包页', /^\/p\/\d+$/.test(await evaluate('location.pathname')));
  const packTiles = await evaluate(`document.querySelectorAll('.tile').length`);
  check('图包内瀑布流有内容', packTiles === 1, `${packTiles} 个`);

  if (await realRightClick('.tile')) {
    const labels = await readMenuAndClose();
    check(
      '右键图片出现图片菜单',
      labels.includes('重命名') && labels.includes('移动到其他图包') && labels.includes('删除'),
      labels.join(' / ')
    );
  }

  // 标题右侧必须有日期（拍摄月份或创建日期），格式 YYYY-MM / YYYY-MM-DD
  const packDate = await evaluate(`document.querySelector('.pack-date')?.textContent?.trim() || ''`);
  check('图包标题右侧显示日期', /^\d{4}-\d{2}(-\d{2})?$/.test(packDate), packDate);

  // 编辑弹窗要能改拍摄日期
  await evaluate(`document.querySelector('[data-rename]').click()`);
  await sleep(500);
  const editFields = await evaluate(`
    (() => {
      const m = document.querySelector('.modal');
      if (!m) return null;
      return {
        hasMonth: Boolean(m.querySelector('[name=month]')),
        monthValue: m.querySelector('[name=month]')?.value || '',
      };
    })()
  `);
  check('编辑弹窗含可编辑的拍摄日期', editFields && editFields.hasMonth === true, editFields ? editFields.monthValue : '');
  await evaluate(`document.querySelector('.modal [data-cancel]').click()`);
  await sleep(300);

  // 9. 删除角色（走接口，顺带验证级联清理）
  const charId = Number(newPath.split('/').pop());
  const delRes = await fetch(`${BASE}/api/characters/${charId}`, { method: 'DELETE' });
  check('删除测试角色', delRes.ok, `HTTP ${delRes.status}`);
  const stillThere = await fetch(`${BASE}/api/characters/${charId}`).then((r) => r.status);
  check('删除后角色确实不存在', stillThere === 404, `HTTP ${stillThere}`);

  check('页面无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (err) {
  check('测试执行中断', false, String(err.message || err));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过\n`);

ws.close();
child.kill();
await sleep(200);
process.exit(passed === results.length ? 0 : 1);
