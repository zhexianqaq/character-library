/**
 * 在页面里执行一段 JS 并打印结果（用于排查计算样式 / DOM 结构）。
 * 用法：node tools/inspect.mjs "<url>" "<js表达式>" [等待毫秒]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [, , targetUrl, expr, waitArg] = process.argv;
const waitMs = Number(waitArg) || 3000;
const port = 9700 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), `cl-inspect-${Date.now()}`);

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
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* wait */
    }
    await sleep(120);
  }
  throw new Error('debug port not ready');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
// --size 1040x400 可指定视口
const sizeIdx = process.argv.indexOf('--size');
const [vw, vh] = (sizeIdx > 0 && process.argv[sizeIdx + 1] ? process.argv[sizeIdx + 1] : '1280x900')
  .split('x')
  .map((n) => Number(n) || 0);
await send('Emulation.setDeviceMetricsOverride', {
  width: vw || 1280,
  height: vh || 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: targetUrl });
await sleep(waitMs);

// --hover "<选择器>"：把真实鼠标移到元素中心（合成事件触发不了 :hover）
const hoverIdx = process.argv.indexOf('--hover');
if (hoverIdx > 0 && process.argv[hoverIdx + 1]) {
  const sel = process.argv[hoverIdx + 1];
  const pos = await send('Runtime.evaluate', {
    expression: `(() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    })()`,
    returnByValue: true,
  });
  const p = pos.result.value;
  if (p) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await send('Page.captureScreenshot', { format: 'png' });
    await sleep(400);
  }
}

// --click "<选择器>"：用真实鼠标事件点一下（合成 click 不会移动焦点/触发 :hover）
const clickIdx = process.argv.indexOf('--click');
if (clickIdx > 0 && process.argv[clickIdx + 1]) {
  const sel = process.argv[clickIdx + 1];
  const pos = await send('Runtime.evaluate', {
    expression: `(() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    })()`,
    returnByValue: true,
  });
  const p = pos.result.value;
  if (p) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await sleep(100);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(600);
    // 点完把鼠标移开，模拟真实操作后的状态
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' });
    // 无头模式下不产帧就不会推进 CSS 过渡：抓两次截图强制渲染，再读计算样式
    await send('Page.captureScreenshot', { format: 'png' });
    await sleep(350);
    await send('Page.captureScreenshot', { format: 'png' });
    await sleep(350);
  }
}

const r = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
if (r.exceptionDetails) {
  console.log('ERROR:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
} else {
  console.log(JSON.stringify(r.result.value, null, 2));
}

// --shot <path>：顺便存一张截图
const shotIdx = process.argv.indexOf('--shot');
if (shotIdx > 0 && process.argv[shotIdx + 1]) {
  const out = process.argv[shotIdx + 1];
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('saved ' + out);
}

ws.close();
child.kill();
await sleep(150);
process.exit(0);
