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

  // 3. 图包网格
  const packCount = await evaluate(`document.querySelectorAll('.pack-card').length`);
  check('图包按月渲染', packCount > 0, `${packCount} 个`);

  // 4. 切到全部媒体
  await evaluate(`document.querySelector('[data-view] button[data-v="media"]').click()`);
  await sleep(3000);
  const tiles = await evaluate(`document.querySelectorAll('.tile').length`);
  check('全部媒体瀑布流', tiles > 0, `${tiles} 个 tile`);

  const imgOk = await evaluate(`
    (() => {
      const imgs = [...document.querySelectorAll('.tile img')];
      return imgs.filter(i => i.naturalWidth > 0).length;
    })()
  `);
  check('缩略图实际加载出像素', imgOk > 0, `${imgOk}/${tiles} 张有内容`);

  // 5. 灯箱
  await evaluate(`document.querySelector('.tile').click()`);
  await sleep(2500);
  const lb = await evaluate(`!!document.querySelector('.lightbox')`);
  check('点击打开灯箱', lb === true);
  const lbImg = await evaluate(`document.querySelector('.lightbox img')?.naturalWidth || 0`);
  check('灯箱内大图加载', lbImg > 0, `${lbImg}px 宽`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  check('Esc 关闭灯箱', (await evaluate(`!!document.querySelector('.lightbox')`)) === false);

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
      const input = document.querySelector('input[type=file]');
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
