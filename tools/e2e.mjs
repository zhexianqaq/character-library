/**
 * 端到端测试：用真实 Chrome 跑一遍关键流程。
 * 用法：node tools/e2e.mjs
 * 前置：服务已在 http://127.0.0.1:7788 运行
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
    .then((o) => o.shelves.map((s) => ({ id: s.id, name: s.name, kind: s.kind, bytes: s.bytes, chars: s.characterCount }))))()`);
  check(
    '每个库都有独立的角色数与占用',
    shelves.length > 0 && shelves.every((x) => typeof x.bytes === 'number' && typeof x.chars === 'number'),
    shelves.map((x) => `${x.name}(${x.chars}人/${Math.round(x.bytes / 1048576)}MB)`).join(' / ')
  );
  if (shelves.length > 1) {
    const tabCount = await evaluate(`document.querySelectorAll('[data-shelf]').length`);
    check('库标签数量与接口一致', tabCount === shelves.length, `${tabCount} 个标签`);
    // 表情库没有条目层，切它不会停在 /s/:id，所以这里挑一个普通库来验 URL
    const regular = shelves.filter((s) => s.kind === 'people' || s.kind === 'work');
    const last = regular[regular.length - 1] || shelves[0];
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

    // 资源库标签进 /rs/:id
    const resTab = shelves.find((s) => s.kind === 'resource');
    if (resTab) {
      await evaluate(`document.querySelector('[data-shelf="${resTab.id}"]').click()`);
      await sleep(1600);
      const p2 = await evaluate(`location.pathname`);
      check('资源库标签跳到 /rs/:id', p2 === `/rs/${resTab.id}`, p2);
      await goto(`${BASE}/`, 1600);
    }

    // 表情库标签直接进自己的页面
    const emojiTab = shelves.find((s) => s.kind === 'emoji');
    if (emojiTab) {
      await evaluate(`document.querySelector('[data-shelf="${emojiTab.id}"]').click()`);
      await sleep(1600);
      const p = await evaluate(`location.pathname`);
      check('表情库标签跳到 /e/:id', p === `/e/${emojiTab.id}`, p);
      await goto(`${BASE}/`, 1600);
    }

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
    const shape = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const m = document.querySelector('.modal');
      if (!m) return null;
      const plat = m.querySelector('[name=platform]');
      const dd = m.querySelector('.dd');
      if (plat) {
        plat.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await sleep(280);
      }
      const panel = m.querySelector('.dd-panel');
      const out = {
        platform: !!plat,
        options: m.querySelectorAll('.dd-panel .dd-opt').length,
        handle: !!m.querySelector('[name=handle]'),
        url: !!m.querySelector('[name=url]'),
        rows: m.querySelectorAll('.field-row').length,
        inputW: dd ? Math.round(dd.getBoundingClientRect().width) : 0,
        panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
      return out;
    })()`);
    check(
      '添加平台弹窗 = 自定义下拉 + ID + 网址',
      !!shape && shape.platform && shape.handle && shape.url && shape.options > 5 && shape.rows === 1,
      JSON.stringify(shape)
    );
    check(
      '下拉面板与输入框同宽',
      !!shape && shape.inputW > 0 && shape.inputW === shape.panelW,
      shape ? `${shape.inputW} / ${shape.panelW}` : ''
    );
    check(
      '原生 datalist 已移除（只剩一个三角）',
      (await evaluate(`document.querySelectorAll('.modal datalist').length`)) === 0
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

  // 2.6 多选图包
  const sel = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-select-toggle]').click();
    await sleep(1200);
    const cards = [...document.querySelectorAll('.pack-card')];
    cards[0]?.click();
    cards[1]?.click();
    await sleep(350);
    const out = {
      bar: !!document.querySelector('.sel-bar:not([hidden])'),
      n: document.querySelector('.sel-n b')?.textContent,
      selCount: document.querySelectorAll('.pack-card.is-sel').length,
      ticks: document.querySelectorAll('.pack-card .tick').length,
      path: location.pathname,
    };
    document.querySelector('[data-sel="exit"]').click();
    await sleep(900);
    out.afterBar = !!document.querySelector('.sel-bar:not([hidden])');
    out.afterTicks = document.querySelectorAll('.pack-card .tick').length;
    return out;
  })()`);
  check('选取模式能勾选图包', sel.bar && sel.n === '2' && sel.selCount === 2, JSON.stringify(sel));
  check('选择模式点卡片不跳转', /^\/c\//.test(sel.path), sel.path);
  check('完成后退回普通模式', sel.afterBar === false && sel.afterTicks === 0, `${sel.afterBar}/${sel.afterTicks}`);

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
  // 图包卡片上已经没有 ＋ 按钮了，入口统一走右键 →「添加素材」
  const mediaPicker = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const card = document.querySelector('.pack-card');
    if (!card) return { open: false };
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(rect.left + 40), clientY: Math.round(rect.top + 40),
    }));
    await sleep(260);
    const add = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(b => b.querySelector('span').textContent.trim() === '添加素材');
    if (!add) return { open: false, reason: 'no add item' };
    add.click();
    await sleep(280);
    const item = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(b => b.querySelector('span').textContent.includes('从本角色素材添加'));
    if (!item) return { open: false, reason: 'no sub item' };
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

  // 5. 媒体详情页：先进一个多图图包，保证有「下一张」可翻
  const richPack = await evaluate(`(async () => {
    const r = await fetch('/api/characters/2/packs');
    const d = await r.json();
    return (d.items.find((p) => p.mediaCount > 3) || d.items[0]).id;
  })()`);
  await goto(`${BASE}/p/${richPack}`, 2400);
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

  // 翻页不应该往历史里叠加，点 ✕ 要一次退出来源页
  const nav = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const before = location.pathname;
    const h0 = history.length;
    document.querySelector('[data-next]').click();
    await sleep(1300);
    const after = location.pathname;
    const h1 = history.length;
    document.querySelector('[data-close]').click();
    await sleep(1000);
    return { before, after, h0, h1, end: location.pathname };
  })()`);
  check('→ 翻到下一张', nav.after !== nav.before, `${nav.before} → ${nav.after}`);
  check('翻页不增加历史记录', nav.h1 === nav.h0, `${nav.h0} → ${nav.h1}`);
  check('翻页后 ✕ 一次退出到图包页', nav.end === `/p/${richPack}`, nav.end);
  // 回到角色页继续后面的用例
  await goto(`${BASE}/c/2`, 2200);

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
        body: JSON.stringify({
          platforms: [{ platform: '游戏', handle: '原神', url: '' }],
          tags: ['原神'],
        }),
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
    const workModal = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const m = document.querySelector('.modal');
      if (!m) return null;
      const plat = m.querySelector('[name=platform]');
      if (plat) {
        plat.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await sleep(280);
      }
      const dds = [...m.querySelectorAll('.dd')];
      const out = {
        title: m.querySelector('h3').textContent,
        label: m.querySelector('.field > span').textContent.trim(),
        options: [...m.querySelectorAll('.dd-panel .dd-opt')].map((o) => o.textContent.trim()),
        ddCount: dds.length,
      };
      // 第二个下拉是作品名：既能选已有资源，也能直接输入
      if (dds[1]) {
        const wi = dds[1].querySelector('.dd-input');
        out.workEditable = wi.dataset.ddEditable === '1';
        wi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await sleep(260);
        out.workOptions = [...dds[1].querySelectorAll('.dd-opt')].map((o) => o.textContent.trim());
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
      return out;
    })()`);
    check(
      '出处弹窗是「类型 + 作品名」',
      !!workModal && workModal.title === '添加出处' && workModal.label.startsWith('出处类型') && workModal.options.includes('动画'),
      JSON.stringify(workModal)
    );
    check(
      '作品名是下拉 + 可输入',
      !!workModal && workModal.ddCount === 2 && workModal.workEditable === true && (workModal.workOptions || []).includes('原神'),
      JSON.stringify(workModal && { workEditable: workModal.workEditable, workOptions: workModal.workOptions })
    );
    await evaluate(`document.querySelector('.modal [data-cancel]').click()`);
    await sleep(200);

    // 标签：点击进对应资源，删除走右键
    const tagNav = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const chip = [...document.querySelectorAll('[data-tags] .chip[data-tag]')]
        .find((c) => c.textContent.trim() === '原神');
      if (!chip) return { ok: false };
      const out = { ok: true, linked: chip.classList.contains('link'), hasX: chip.textContent.includes('×') };
      chip.click();
      await sleep(1600);
      out.path = location.pathname;
      return out;
    })()`);
    check(
      '点标签进入对应资源',
      tagNav.ok && tagNav.linked && /^\/r\/\d+$/.test(tagNav.path || ''),
      JSON.stringify(tagNav)
    );
    check('标签不再挂 ×（删除挪到右键）', tagNav.ok && tagNav.hasX === false);

    await goto(`${BASE}/c/${workId}`, 1600);
    const tagMenu = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const chip = [...document.querySelectorAll('[data-tags] .chip[data-tag]')]
        .find((c) => c.textContent.trim() === '原神');
      const r = chip.getBoundingClientRect();
      chip.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 10), clientY: Math.round(r.bottom + 4),
      }));
      await sleep(300);
      const items = [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => ({
        t: b.querySelector('span').textContent.trim(),
        disabled: b.disabled,
      }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);
      return items;
    })()`);
    check(
      '标签右键有「删除标签」',
      tagMenu.some((i) => i.t === '删除标签' && !i.disabled) && tagMenu.some((i) => i.t.includes('打开对应的资源')),
      JSON.stringify(tagMenu)
    );

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

  const createFields = await evaluate(`[...document.querySelectorAll('.modal .field > span')].map((s) => s.textContent.trim())`);
  check(
    '新建角色只问名字和简介',
    createFields.length === 2 && !createFields.some((f) => f.includes('账号')),
    createFields.join(' / ')
  );
  await evaluate(`
    (() => {
      const m = document.querySelector('.modal');
      m.querySelector('[name=name]').value = 'E2E 测试角色';
      m.querySelector('[data-ok]').click();
      return true;
    })()
  `);
  await sleep(1800);
  const newPath = await evaluate('location.pathname');
  check('提交后进入新角色页', /^\/c\/\d+$/.test(newPath), newPath);
  const newName = await evaluate(`document.querySelector('.hero-name')?.textContent?.trim() || ''`);
  check('新角色名正确', newName === 'E2E 测试角色', newName);

  // 7.1 新建人物当场就要把目录和「未分类/图片、未分类/视频」建出来（以前要等第一次上传）
  const dirCheck = await (async () => {
    const cid = Number(newPath.split('/').pop());
    const c = await fetch(`${BASE}/api/characters/${cid}`).then((r) => r.json());
    const ov = await fetch(`${BASE}/api/overview`).then((r) => r.json());
    const dirAbs = path.join(ov.library.rootPath, ...String(c.dirSlug).split('/'));
    const stat = (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    return {
      dirSlug: c.dirSlug,
      root: stat(dirAbs),
      img: stat(path.join(dirAbs, '未分类', '图片')),
      vid: stat(path.join(dirAbs, '未分类', '视频')),
    };
  })();
  check(
    '新建人物立刻建出目录 + 未分类子目录',
    dirCheck.root && dirCheck.img && dirCheck.vid,
    `${dirCheck.dirSlug} · 根=${dirCheck.root} 图片=${dirCheck.img} 视频=${dirCheck.vid}`
  );

  // 7.1 Esc：只关最上面一层
  const escModal = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.querySelector('[data-edit]').click();
    await sleep(520);
    const opened = !!document.querySelector('.modal');
    esc();
    await sleep(420);
    return { opened, closed: !document.querySelector('.modal'), path: location.pathname };
  })()`);
  check('Esc 关闭弹窗', escModal.opened && escModal.closed, JSON.stringify(escModal));

  const escLayer = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.querySelector('[data-add-platform]').click();
    await sleep(620);
    const dd = document.querySelector('.modal .dd');
    dd.querySelector('.dd-input').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(380);
    esc();
    await sleep(380);
    const afterFirst = { panel: !dd.querySelector('.dd-panel').hidden, modal: !!document.querySelector('.modal') };
    esc();
    await sleep(420);
    return { afterFirst, modalAfter: !!document.querySelector('.modal'), path: location.pathname };
  })()`);
  check(
    'Esc 只关最上面一层（先下拉、后弹窗）',
    escLayer.afterFirst.panel === false && escLayer.afterFirst.modal === true && escLayer.modalAfter === false,
    JSON.stringify(escLayer)
  );

  const escSelect = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-select-toggle]').click();
    await sleep(900);
    const on = !!document.querySelector('.sel-bar:not([hidden])');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(700);
    return {
      on,
      off: !document.querySelector('.sel-bar:not([hidden])'),
      btn: document.querySelector('[data-select-toggle]').textContent.trim(),
    };
  })()`);
  check(
    'Esc 退出选取模式',
    escSelect.on && escSelect.off && escSelect.btn === '选取',
    JSON.stringify(escSelect)
  );

  const escIntro = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const el = document.querySelector('[data-intro]');
    const before = el.textContent;
    el.click();
    await sleep(260);
    const ta = el.querySelector('textarea');
    if (!ta) return { ok: false };
    ta.value = 'E2E 不该保存的文字';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(650);
    return {
      ok: true,
      same: document.querySelector('[data-intro]').textContent === before,
      hasTa: !!document.querySelector('[data-intro] textarea'),
    };
  })()`);
  check(
    'Esc 取消简介编辑（还原原值）',
    escIntro.ok && escIntro.same && escIntro.hasTa === false,
    JSON.stringify(escIntro)
  );

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

  // 7.2 标签继承：条目上的通用标签不下发，只下发条目名 + 库标签
  const tagRule = await evaluate(`(async () => {
    const id = location.pathname.split('/').pop();
    const c = await (await fetch('/api/characters/' + id)).json();
    await fetch('/api/characters/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [...c.tags, 'ZzGenericTag'] }),
    });
    const m = await (await fetch('/api/characters/' + id + '/media')).json();
    const first = m.items[0] || { tags: [], ownTags: [] };
    const after = await (await fetch('/api/characters/' + id)).json();
    return { charTags: after.tags, mediaTags: first.tags || [] };
  })()`);
  check(
    '条目上的通用标签不再下发到媒体',
    (tagRule.charTags || []).includes('ZzGenericTag') && !(tagRule.mediaTags || []).includes('ZzGenericTag'),
    JSON.stringify(tagRule.mediaTags)
  );
  check(
    '媒体仍继承条目名 + 库标签',
    (tagRule.mediaTags || []).includes('E2E 测试角色') &&
      ((tagRule.mediaTags || []).includes('人物') || (tagRule.mediaTags || []).includes('角色')),
    JSON.stringify(tagRule.mediaTags)
  );

  // 7.2b 图包标签同步到包内每张图：不遗漏、不重复、不外溢、可撤销
  const packTagFlow = await evaluate(`(async () => {
    const cid = Number(location.pathname.split('/').pop());
    const packs = await (await fetch('/api/characters/' + cid + '/packs')).json();
    const pack = (packs.items || []).find((p) => p.mediaCount > 0);
    if (!pack) return { ok: false, reason: '没有带媒体的图包' };
    const orig = pack.tags || [];
    const patch = (tags) =>
      fetch('/api/packs/' + pack.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
    const char = await (await fetch('/api/characters/' + cid)).json();
    const TAG = 'E2E 图包标签';

    // 一个全新标签 + 一个和条目名同名的标签（测去重）
    await patch([...orig, TAG, char.name]);
    const all = (await (await fetch('/api/characters/' + cid + '/media')).json()).items;
    const inPack = all.filter((m) => m.packId === pack.id);
    const outside = all.filter((m) => m.packId !== pack.id);
    const covered = inPack.length > 0 && inPack.every((m) => (m.tags || []).includes(TAG));
    const nameOnce = inPack.every((m) => (m.tags || []).filter((t) => t === char.name).length === 1);
    const noDup = inPack.every((m) => new Set(m.tags || []).size === (m.tags || []).length);
    const leaked = outside.filter((m) => (m.tags || []).includes(TAG)).length;

    const packMedia = (await (await fetch('/api/packs/' + pack.id + '/media')).json()).items;
    const packApiCovered = packMedia.length > 0 && packMedia.every((m) => (m.tags || []).includes(TAG));
    const detail = await (await fetch('/api/media/' + inPack[0].id)).json();

    await patch(orig);
    const after = (await (await fetch('/api/characters/' + cid + '/media')).json()).items.filter(
      (m) => m.packId === pack.id
    );
    return {
      ok: true,
      n: inPack.length,
      covered,
      nameOnce,
      noDup,
      leaked,
      packApiCovered,
      detailTags: detail.tags || [],
      detailPackTags: detail.packTags || [],
      detailOwn: detail.ownTags || [],
      TAG,
      residue: after.filter((m) => (m.tags || []).includes(TAG)).length,
      nameStill: after.every((m) => (m.tags || []).includes(char.name)),
    };
  })()`);
  check(
    '图包标签下发到包内每张图（不遗漏）',
    packTagFlow.ok && packTagFlow.covered && packTagFlow.packApiCovered,
    `${packTagFlow.n} 张 · 列表=${packTagFlow.covered} 图包页=${packTagFlow.packApiCovered}`
  );
  check(
    '继承标签不重复、不外溢到其它图包',
    packTagFlow.nameOnce && packTagFlow.noDup && packTagFlow.leaked === 0,
    `同名只出现一次=${packTagFlow.nameOnce} 无重复=${packTagFlow.noDup} 外溢=${packTagFlow.leaked}`
  );
  check(
    '详情页能区分图包标签与自身标签',
    (packTagFlow.detailPackTags || []).includes(packTagFlow.TAG) &&
      (packTagFlow.detailTags || []).includes(packTagFlow.TAG) &&
      !(packTagFlow.detailOwn || []).includes(packTagFlow.TAG),
    `tags=${JSON.stringify(packTagFlow.detailTags)} pack=${JSON.stringify(packTagFlow.detailPackTags)} own=${JSON.stringify(packTagFlow.detailOwn)}`
  );
  check(
    '图包标签撤销后不留残余',
    packTagFlow.residue === 0 && packTagFlow.nameStill,
    `残余 ${packTagFlow.residue} 张 · 条目名仍在=${packTagFlow.nameStill}`
  );

  // 7.3 媒体右键的封面两项
  const coverFlow = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cid = location.pathname.split('/').pop();
    document.querySelector('[data-view] button[data-v="media"]').click();
    await sleep(2400);
    const tile = document.querySelector('.tile');
    const id = Number(tile.dataset.id);
    const media = await (await fetch('/api/characters/' + cid + '/media')).json();
    const packId = (media.items.find((m) => m.id === id) || {}).packId || null;

    const openMenu = async () => {
      const r = tile.getBoundingClientRect();
      tile.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 30),
      }));
      await sleep(320);
    };
    const labelsOf = () => [...document.querySelectorAll('.ctx-menu .ctx-item > span')].map((s) => s.textContent.trim());
    const clickItem = (txt) => {
      const btn = [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes(txt));
      if (!btn) return false;
      btn.click();
      return true;
    };

    await openMenu();
    const labels = labelsOf();
    // 人物库叫「设为人物封面」、角色库叫「设为角色封面」，别写死
    const ownerLabel = labels.find((l) => l !== '设为图包封面' && l.startsWith('设为') && l.includes('封面')) || '';
    clickItem(ownerLabel);
    await sleep(1300);
    const toastOwner = document.querySelector('#toast')?.textContent || '';
    const heroSrc = document.querySelector('.hero-cover img')?.getAttribute('src') || '';

    await openMenu();
    clickItem('设为图包封面');
    await sleep(1300);
    const toastPack = document.querySelector('#toast')?.textContent || '';
    const packs = await (await fetch('/api/characters/' + cid + '/packs')).json();
    const packCovered = packs.items.filter((p) => p.coverMediaId === id).length;

    if (document.querySelector('.ctx-menu')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(200);
    }
    return { id, packId, labels, toastOwner, heroSrc, toastPack, packCovered };
  })()`);
  check(
    '媒体右键有「设为图包封面 / 设为条目封面」',
    coverFlow.labels.includes('设为图包封面') &&
      coverFlow.labels.some((l) => l !== '设为图包封面' && l.startsWith('设为') && l.includes('封面')),
    coverFlow.labels.join(' / ')
  );
  check(
    '设为人物封面生效并刷新头像',
    coverFlow.toastOwner.includes('封面') && coverFlow.heroSrc === `/t/${coverFlow.id}`,
    `${coverFlow.toastOwner} · ${coverFlow.heroSrc}`
  );
  check(
    '设为图包封面生效',
    coverFlow.toastPack.includes('封面') && coverFlow.packCovered >= 1,
    `${coverFlow.toastPack} · ${coverFlow.packCovered} 个包用了这张`
  );

  // 移出图包后重新进页面（列表有缓存，必须重载才是新归属）
  await evaluate(`fetch('/api/media/${coverFlow.id}', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packId: null }),
  })`);
  await goto(`${BASE}${newPath}`, 2000);
  const looseMenu = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-view] button[data-v="media"]').click();
    await sleep(2200);
    const tile = document.querySelector('.tile[data-id="${coverFlow.id}"]') || document.querySelector('.tile');
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 30),
    }));
    await sleep(320);
    const labels = [...document.querySelectorAll('.ctx-menu .ctx-item > span')].map((s) => s.textContent.trim());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(200);
    return labels;
  })()`);
  check(
    '不在图包里的图不显示「设为图包封面」',
    !looseMenu.includes('设为图包封面') && looseMenu.some((l) => l.startsWith('设为') && l.includes('封面')),
    looseMenu.join(' / ')
  );

  // 放回原图包，后面的图包页用例还要用
  if (coverFlow.packId) {
    await evaluate(`fetch('/api/media/${coverFlow.id}', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packId: ${coverFlow.packId} }),
    })`);
  }
  await goto(`${BASE}${newPath}`, 1800);

  // 回到图包视图，7.5 要在图包视图操作
  await evaluate(`document.querySelector('[data-view] button[data-v="packs"]').click()`);
  await sleep(1200);

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

  // 8.6 资源库：卡片 → 详情 → 关联角色（带标签筛选）→ 出处跳回资源
  const resShelf = shelves.find((s) => s.kind === 'resource');
  if (resShelf) {
    await goto(`${BASE}/rs/${resShelf.id}`, 2200);
    const readList = () => evaluate(`(() => ({
      cards: document.querySelectorAll('.res-card').length,
      tabs: [...document.querySelectorAll('[data-cat] button')].map((b) => b.textContent.trim()),
    }))()`);
    let resList = await readList();
    // 库是空的就自己造一张（跑完删掉），否则用例会被真实数据的增删带崩
    let tempResId = 0;
    if (!resList.cards) {
      tempResId = await evaluate(`(async () => {
        const r = await fetch('/api/characters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shelfId: ${resShelf.id}, name: 'E2E 临时资源', category: '游戏' }),
        });
        const d = await r.json();
        return d.id || 0;
      })()`);
      await goto(`${BASE}/rs/${resShelf.id}`, 1800);
      resList = await readList();
    }
    check('资源库按分类分组展示卡片', resList.cards > 0 && resList.tabs.some((t) => t.startsWith('游戏')), resList.tabs.join(' / '));

    // 关联靠标签：造一个带同名标签 + 同名出处的条目，跑完删掉
    const workShelf = shelves.find((s) => s.kind === 'work');
    const link = workShelf
      ? await evaluate(`(async () => {
          const list = await (await fetch('/api/shelves/${resShelf.id}/resources')).json();
          const res = list.items[0];
          if (!res) return { ok: false };
          const r = await fetch('/api/characters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shelfId: ${workShelf.id}, name: 'E2E 资源关联', tags: [res.name] }),
          });
          const c = await r.json();
          await fetch('/api/characters/' + c.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platforms: [{ platform: '游戏', handle: res.name, url: '' }] }),
          });
          return { ok: true, resName: res.name, charId: c.id };
        })()`)
      : { ok: false };

    // 右键：资源卡片
    if (await realRightClick('.res-card')) {
      const labels = await readMenuAndClose();
      check(
        '资源卡片右键有菜单',
        ['打开', '编辑资源', '编辑标签', '复制名称', '删除'].every((l) => labels.includes(l)),
        labels.join(' / ')
      );
    }
    const resBlank = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const page = document.querySelector('.page');
      page.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 700 }));
      await sleep(300);
      const out = [...document.querySelectorAll('.ctx-menu .ctx-item > span')].map((s) => s.textContent.trim());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(220);
      return out;
    })()`);
    check(
      '资源库空白处右键有菜单',
      resBlank.includes('新建资源') && resBlank.includes('只看分类') && resBlank.includes('编辑库'),
      resBlank.join(' / ')
    );

    const resId = await evaluate(`Number(document.querySelector('.res-card').dataset.id)`);
    await evaluate(`document.querySelector('.res-card').click()`);
    await sleep(1800);
    const resDetail = await evaluate(`(() => ({
      path: location.pathname,
      name: document.querySelector('.hero-name')?.textContent || '',
      related: document.querySelectorAll('[data-related] .char-card').length,
      stats: [...document.querySelectorAll('.stat span')].map((s) => s.textContent.trim()),
    }))()`);
    check(
      '资源详情：封面 + 名称 + 标签 + 简介 + 关联卡片',
      resDetail.path === `/r/${resId}` && resDetail.name.length > 0 && resDetail.related > 0 &&
        resDetail.stats.includes('相关条目'),
      `${resDetail.name} · ${resDetail.related} 个关联`
    );

    // 右键：关联卡片 / 空白处
    if (await realRightClick('[data-entry]')) {
      const labels = await readMenuAndClose();
      check(
        '资源详情关联卡片右键有菜单',
        labels.includes('打开条目') && labels.some((l) => l.startsWith('只看「')) && labels.includes('复制条目名'),
        labels.join(' / ')
      );
    }
    const detailBlank = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const page = document.querySelector('.page');
      page.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 700 }));
      await sleep(300);
      const out = [...document.querySelectorAll('.ctx-menu .ctx-item > span')].map((s) => s.textContent.trim());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(220);
      return out;
    })()`);
    check(
      '资源详情空白处右键有菜单',
      detailBlank.includes('编辑资源') && detailBlank.includes('编辑标签') && detailBlank.includes('删除资源'),
      detailBlank.join(' / ')
    );

    const resName = resDetail.name;
    await evaluate(`document.querySelector('[data-related] .char-card').click()`);
    await sleep(2000);
    const filtered = await evaluate(`(() => ({
      path: location.pathname + location.search,
      note: document.querySelector('[data-res-note]')?.textContent || '',
      noteShown: !document.querySelector('[data-res-note]')?.hidden,
      packs: document.querySelectorAll('.pack-card').length,
    }))()`);
    check(
      '跳角色页时自动带上 ?res= 并只显示该标签图包',
      filtered.noteShown && filtered.note.includes(resName) && filtered.path.includes('res='),
      `${decodeURIComponent(filtered.path)} · ${filtered.packs} 个图包`
    );

    // 出处点「原神」→ 回资源详情
    const viaOrigin = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const card = [...document.querySelectorAll('.pf-card')]
        .find((c) => c.textContent.includes(${JSON.stringify(resName)}));
      if (!card) return { ok: false };
      card.click();
      await sleep(1500);
      return { ok: true, path: location.pathname };
    })()`);
    check(
      '出处点资源名会打开资源详情',
      viaOrigin.ok && viaOrigin.path === `/r/${resId}`,
      viaOrigin.ok ? viaOrigin.path : '出处里没有这个名称'
    );

    // 资源库支持逗号批量新建（造完立刻删，别影响后面的用例）
    await goto(`${BASE}/rs/${resShelf.id}`, 1800);
    const resBatch = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const names = ['E2E 资源甲', 'E2E 资源乙', 'E2E 资源丙'];
      document.querySelector('[data-new-res]').click();
      await sleep(520);
      const m = document.querySelector('.modal');
      if (!m) return { ok: false, reason: '弹窗没开' };
      m.querySelector('[name=name]').value = names.join('，');
      m.querySelector('[data-ok]').click();
      await sleep(2800);
      const d = await (await fetch('/api/shelves/${resShelf.id}/resources')).json();
      const made = (d.items || []).filter((x) => names.includes(x.name));
      return {
        ok: true,
        names,
        made: made.map((x) => x.name),
        ids: made.map((x) => x.id),
        cats: [...new Set(made.map((x) => x.category))],
        toast: document.querySelector('#toast')?.textContent || '',
        cards: document.querySelectorAll('.res-card').length,
      };
    })()`);
    check(
      '资源库支持逗号批量新建',
      resBatch.ok && resBatch.made.length === 3 && resBatch.cats.length === 1,
      resBatch.ok ? `${resBatch.made.join(' / ')} · ${resBatch.toast}` : resBatch.reason
    );
    for (const id of resBatch.ids || []) {
      await fetch(`${BASE}/api/characters/${id}`, { method: 'DELETE' });
    }

    // 清理这一节造的数据
    if (link.ok && link.charId) {
      await evaluate(`fetch('/api/characters/${link.charId}', { method: 'DELETE' }).then((r) => r.status)`);
    }
    if (tempResId) {
      await evaluate(`fetch('/api/characters/${tempResId}', { method: 'DELETE' }).then((r) => r.status)`);
    }
  }

  // 9. 表情库：扁平库 = 图包 / 未分类 / 全部素材
  const emojiShelf = shelves.find((s) => s.kind === 'emoji');
  if (emojiShelf) {
    await goto(`${BASE}/e/${emojiShelf.id}`, 2600);
    const emo = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.emoji-card')];
      return {
        cards: cards.length,
        mosaics: cards.map((c) => c.querySelectorAll('.mosaic img').length),
        tabs: [...document.querySelectorAll('[data-view] button')].map((b) => b.dataset.v),
        meta: document.querySelector('[data-shelf-meta]')?.textContent || '',
        entryRows: document.querySelectorAll('.hero, .char-grid').length,
      };
    })()`);
    check(
      '表情库直接展示图包（没有条目层）',
      emo.cards > 0 && emo.meta.includes('个图包') && emo.entryRows === 0,
      `${emo.cards} 个图包 · ${emo.meta}`
    );
    check(
      '图包封面是前 9 张拼图',
      emo.mosaics.every((n) => n > 0 && n <= 9) && emo.mosaics.some((n) => n === 9),
      emo.mosaics.join(' / ')
    );
    check(
      '三个分区：图包 / 未分类 / 全部素材',
      JSON.stringify(emo.tabs) === JSON.stringify(['packs', 'loose', 'all']),
      emo.tabs.join(' / ')
    );

    const emoFilter = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-view] button[data-v="all"]').click();
      await sleep(2600);
      const bar = document.querySelector('[data-filter-bar]');
      const out = {
        all: document.querySelectorAll('.tile').length,
        barShown: !bar.hidden,
        packDD: bar.querySelectorAll('.dd').length,
      };
      bar.querySelector('[data-k="anim"]').click();
      await sleep(900);
      out.anim = document.querySelectorAll('.tile').length;
      out.badges = document.querySelectorAll('.tile .gif').length;
      bar.querySelector('[data-k="still"]').click();
      await sleep(900);
      out.still = document.querySelectorAll('.tile').length;
      bar.querySelector('[data-k=""]').click();
      await sleep(700);
      return out;
    })()`);
    check('全部素材有筛选条（类型 + 标签 + 图包 + 排序）', emoFilter.barShown && emoFilter.packDD === 3, JSON.stringify({ dds: emoFilter.packDD }));
    check(
      '动图 / 表情 能分开筛',
      emoFilter.anim > 0 && emoFilter.still > 0 && emoFilter.anim + emoFilter.still === emoFilter.all,
      `${emoFilter.all} = ${emoFilter.anim} 动图 + ${emoFilter.still} 表情`
    );
    check('gif 瓦片带 GIF 角标', emoFilter.badges === emoFilter.anim, `${emoFilter.badges} 个角标`);

    // 选取图包
    const emoSel = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-view] button[data-v="packs"]').click();
      await sleep(1200);
      document.querySelector('[data-select-toggle]').click();
      await sleep(1000);
      const cards = [...document.querySelectorAll('.emoji-card')];
      cards[0].click();
      cards[1].click();
      await sleep(300);
      const out = {
        n: document.querySelector('.sel-n b')?.textContent,
        acts: [...document.querySelectorAll('.sel-bar button')].map((b) => b.textContent.trim()),
        path: location.pathname,
      };
      document.querySelector('[data-sel="exit"]').click();
      await sleep(700);
      return out;
    })()`);
    check(
      '表情库图包能多选 / 解散 / 删除',
      emoSel.n === '2' && emoSel.acts.includes('解散') && emoSel.acts.includes('删除'),
      `${emoSel.n} 个 · ${emoSel.acts.join(' ')}`
    );

    // 详情页：gif 走原件才动得起来
    const gifId = await evaluate(`(async () => {
      const d = await (await fetch('/api/shelves/${emojiShelf.id}/emoji')).json();
      const p = d.packs.find((x) => x.animCount > 0) || d.packs[0];
      const m = await (await fetch('/api/packs/' + p.id + '/media')).json();
      // 要挑「真动图」（anim），不是扩展名为 gif 的静态图
      const hit = m.items.find((x) => x.anim) || m.items[0];
      return hit ? hit.id : 0;
    })()`);
    if (gifId) {
      await goto(`${BASE}/i/${gifId}`, 2600);
      const gif = await evaluate(`(() => {
        const img = document.querySelector('.mp-canvas img');
        return {
          src: img?.getAttribute('src') || '',
          chip: document.querySelector('.mp-chip-name')?.textContent || '',
          rows: [...document.querySelectorAll('.mp-row > span')].map((s) => s.textContent),
          kicker: document.querySelector('.mp-kicker')?.textContent || '',
        };
      })()`);
      check('gif 详情页用原件（能动）', gif.src === `/m/${gifId}`, gif.src);
      check(
        '表情库详情页只显示库 / 图包，不显示条目',
        gif.chip.startsWith(emojiShelf.name) && !gif.rows.includes('关联'),
        `${gif.chip} · ${gif.rows.join('/')}`
      );
      check('gif 详情页标题是 GIF DETAILS', gif.kicker === 'GIF DETAILS', gif.kicker);
    }
  }

  // 8.8 批量新建：中英文逗号分隔
  await goto(`${BASE}/`, 1600);
  const batch = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = document.querySelector('[data-new-char]');
    if (!btn) return { ok: false };
    btn.click();
    await sleep(520);
    const m = document.querySelector('.modal');
    if (!m) return { ok: false };
    m.querySelector('[name=name]').value = 'E2E 批量甲，E2E 批量乙';
    m.querySelector('[data-ok]').click();
    await sleep(3000);
    const names = [...document.querySelectorAll('.char-card .name')].map((n) => n.textContent.trim());
    return {
      ok: true,
      names: names.filter((n) => n.startsWith('E2E 批量')),
      toast: document.querySelector('#toast')?.textContent || '',
    };
  })()`);
  check(
    '中英文逗号可批量新建',
    batch.ok && (batch.names || []).length === 2,
    `${batch.toast || ''} · ${(batch.names || []).join(' / ')}`
  );

  // 清掉批量造的角色
  await evaluate(`(async () => {
    const ov = await (await fetch('/api/overview')).json();
    for (const s of ov.shelves) {
      const d = await (await fetch('/api/shelves/' + s.id + '/characters')).json().catch(() => ({ items: [] }));
      for (const c of d.items || []) {
        if (c.name.indexOf('E2E 批量') === 0) await fetch('/api/characters/' + c.id, { method: 'DELETE' });
      }
    }
    return true;
  })()`);

  // 8.5 多选：Shift 连选 / Ctrl 加减 / Delete 删除 / Enter 打开
  const kbCharId = Number(newPath.split('/').pop());
  await evaluate(`(async () => {
    for (const t of ['E2E 键A', 'E2E 键B']) {
      await fetch('/api/characters/${kbCharId}/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
    }
    return true;
  })()`);
  await goto(`${BASE}${newPath}`, 2000);

  const kb = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const count = () => document.querySelectorAll('.pack-card.is-sel').length;
    document.querySelector('[data-select-toggle]').click();
    await sleep(1100);
    const cards = [...document.querySelectorAll('.pack-card')];
    const out = { total: cards.length };
    cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    cards[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await sleep(280);
    out.range = count();
    cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    await sleep(250);
    out.ctrlOff = count();
    cards[3].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    await sleep(250);
    out.ctrlAdd = count();

    // Enter 打开单个选中项
    document.querySelector('[data-sel="exit"]').click();
    await sleep(700);
    document.querySelector('[data-select-toggle]').click();
    await sleep(900);
    document.querySelector('.pack-card').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(250);
    key('Enter');
    await sleep(1600);
    out.enterPath = location.pathname;
    history.back();
    await sleep(1500);

    // Delete → 确认框 → Enter 确认
    document.querySelector('[data-select-toggle]').click();
    await sleep(900);
    const cs = [...document.querySelectorAll('.pack-card')];
    cs[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    cs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await sleep(280);
    out.beforeDel = cs.length;
    key('Delete');
    await sleep(700);
    out.dialog = document.querySelector('.modal h3')?.textContent || '';
    key('Enter');
    await sleep(2200);
    out.afterDel = document.querySelectorAll('.pack-card').length;
    return out;
  })()`);
  check(
    'Shift 连选 / Ctrl 加减互不冲突',
    kb.range === 3 && kb.ctrlOff === 2 && kb.ctrlAdd === 3,
    `range ${kb.range} / ctrl- ${kb.ctrlOff} / ctrl+ ${kb.ctrlAdd}`
  );
  check('Enter 打开选中的图包', /^\/p\/\d+$/.test(kb.enterPath || ''), kb.enterPath);
  check(
    'Delete 触发删除、Enter 确认',
    /删除 \d+ 个图包/.test(kb.dialog || '') && kb.afterDel === kb.beforeDel - 2,
    `${kb.dialog} · ${kb.beforeDel} → ${kb.afterDel}`
  );

  // 8.95 顶栏搜索不失焦 + 批量新建中途切库不串库
  const libInfo = await fetch(`${BASE}/api/overview`).then((r) => r.json());
  const peopleShelf =
    (libInfo.shelves || []).find((s) => s.kind === 'people') || (libInfo.shelves || [])[0];
  const workShelf = (libInfo.shelves || []).find((s) => s.kind === 'work');
  await goto(`${BASE}/s/${peopleShelf.id}`, 1800);
  const searchFocus = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = () => document.querySelector('.search input');
    box().focus();
    const steps = [];
    for (const ch of 'zz焦点') {
      const el = box();
      el.value += ch;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await sleep(320); // 超过 240ms 防抖，每敲一个字都真的触发一次搜索
      steps.push({ ch, focused: document.activeElement === box(), value: box() && box().value });
    }
    return { steps, empty: !!document.querySelector('.grid .empty, .char-grid .empty') };
  })()`);
  check(
    '顶栏搜索连续输入不丢焦点',
    searchFocus.steps.length === 4 &&
      searchFocus.steps.every((s) => s.focused) &&
      searchFocus.steps[3].value === 'zz焦点' &&
      searchFocus.empty,
    JSON.stringify(searchFocus.steps)
  );

  const shelfLock = workShelf
    ? await evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const names = ['E2E 库锁甲', 'E2E 库锁乙', 'E2E 库锁丙'];
        document.querySelector('.search input').value = '';
        document.querySelector('.search input').dispatchEvent(new InputEvent('input', { bubbles: true }));
        await sleep(500);
        document.querySelector('[data-new-char]').click();
        await sleep(520);
        const m = document.querySelector('.modal');
        m.querySelector('[name=name]').value = names.join('，');
        m.querySelector('[data-ok]').click();
        // 批量还在跑的时候切到角色库：以前循环里读的是可变的 state.shelfId，剩下的会被丢进新库
        setTimeout(() => document.querySelector('[data-shelf="${workShelf.id}"]').click(), 160);
        await sleep(4200);
        const rows = [];
        for (const sid of [${peopleShelf.id}, ${workShelf.id}]) {
          const d = await (await fetch('/api/shelves/' + sid + '/characters')).json();
          for (const c of d.items || []) if (names.includes(c.name)) rows.push({ name: c.name, shelf: sid, id: c.id });
        }
        return { rows, names, path: location.pathname };
      })()`)
    : { rows: [], names: [], skipped: true };
  check(
    '批量新建中途切库也不串库',
    workShelf &&
      shelfLock.rows.length === 3 &&
      shelfLock.rows.every((r) => r.shelf === peopleShelf.id),
    workShelf ? JSON.stringify(shelfLock.rows.map((r) => `${r.name}@${r.shelf}`)) : '没有 work 类型的库，跳过'
  );
  for (const r of shelfLock.rows || []) {
    await fetch(`${BASE}/api/characters/${r.id}`, { method: 'DELETE' });
  }

  // 8.9 超宽素材跨两列：宽/高 > 2 的占两列（248 = 2×120 + 间隙），其余仍是 120
  const spanCharId = Number(newPath.split('/').pop());
  const spanUpload = await evaluate(`(async () => {
    const mk = async (w, h, name) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3f6f8f'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif'; ctx.fillText(name, 32, Math.round(h / 2));
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], name + '.png', { type: 'image/png' });
    };
    const fd = new FormData();
    fd.append('files', await mk(1200, 300, 'e2e-wide-20250316'));
    fd.append('files', await mk(600, 800, 'e2e-tall-20250316'));
    const r = await (await fetch('/api/characters/' + ${spanCharId} + '/media', { method: 'POST', body: fd })).json();
    return r;
  })()`);
  const wideId = (spanUpload.ids || [])[0];
  const tallId = (spanUpload.ids || [])[1];
  await goto(`${BASE}/c/${spanCharId}`, 2200);
  const span = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-view] button[data-v=media]').click();
    for (let i = 0; i < 50; i += 1) {
      if (document.querySelectorAll('.tile').length >= 2) break;
      await sleep(120);
    }
    await sleep(420);
    const m = document.querySelector('.masonry');
    const mb = m.getBoundingClientRect();
    const rs = [...document.querySelectorAll('.tile')].map((el) => {
      const b = el.getBoundingClientRect();
      return {
        id: Number(el.dataset.id),
        w: Math.round(b.width),
        h: Math.round(b.height),
        x: Math.round(b.left - mb.left),
        y: Math.round(b.top - mb.top),
      };
    });
    const pick = (id) => rs.find((o) => o.id === id) || null;
    let overlap = 0;
    for (let i = 0; i < rs.length; i += 1) {
      for (let j = i + 1; j < rs.length; j += 1) {
        const a = rs[i];
        const b = rs[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) overlap += 1;
      }
    }
    const bottom = Math.max(...rs.map((o) => o.y + o.h));
    return {
      spanned: m.classList.contains('is-spanned'),
      wide: pick(${wideId}),
      tall: pick(${tallId}),
      overlap,
      gridOk: rs.every((o) => (o.w === 120 || o.w === 248) && o.x % 128 === 0),
      bottom,
      boxH: Math.round(m.getBoundingClientRect().height),
      n: rs.length,
    };
  })()`);
  check(
    '超宽素材占两列（248px）',
    span.spanned &&
      span.wide &&
      span.wide.w === 248 &&
      Math.abs(span.wide.h - 62) <= 2 &&
      span.tall &&
      span.tall.w === 120 &&
      Math.abs(span.tall.h - 160) <= 2,
    `宽 ${JSON.stringify(span.wide)} / 竖 ${JSON.stringify(span.tall)}`
  );
  check(
    '跨列后列对齐、间隙一致、无重叠',
    span.gridOk && span.overlap === 0 && span.boxH === span.bottom,
    `宽度只含 120/248 且 x 对齐=${span.gridOk} · 重叠=${span.overlap} · 容器高=${span.boxH}/${span.bottom}`
  );

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
