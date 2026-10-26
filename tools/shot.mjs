/**
 * 用 CDP 截图并收集页面控制台错误。
 * 用法: node tools/shot.mjs <url> <out.png> [width] [height] [waitMs]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [, , url, out, wArg, hArg, waitArg] = process.argv;
const width = Number(wArg) || 1440;
const height = Number(hArg) || 1000;
const waitMs = Number(waitArg) || 3500;

if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [w] [h] [waitMs]');
  process.exit(1);
}

const port = 9300 + Math.floor(Math.random() * 300);
const profile = path.join(os.tmpdir(), `cl-shot-${Date.now()}`);
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
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  throw new Error('无法连接 Chrome 页面调试端口');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const errors = [];
const failed = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(d.exception?.description || d.text);
  }
  if (msg.method === 'Network.loadingFailed') {
    failed.push(msg.params);
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
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});

// --throttle <KB/s>：限速，用来观察上传进度这类一闪而过的中间态
const throttleIdx = process.argv.indexOf('--throttle');
if (throttleIdx > 0) {
  const bps = (Number(process.argv[throttleIdx + 1]) || 0) * 1024;
  if (bps > 0) {
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: bps,
      uploadThroughput: bps,
    });
  }
}

await send('Page.navigate', { url });
await sleep(waitMs);

// --eval "<js>" 可以在截图前先操作页面（点开弹窗、切视图等）
const evalIdx = process.argv.indexOf('--eval');
if (evalIdx > 0 && process.argv[evalIdx + 1]) {
  try {
    await send('Runtime.evaluate', {
      expression: process.argv[evalIdx + 1],
      awaitPromise: true,
      userGesture: true,
    });
    await sleep(900);
  } catch (err) {
    console.log('eval failed: ' + err.message);
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
await fs.writeFile(out, Buffer.from(shot.data, 'base64'));

console.log(`saved ${out}`);
console.log(`console errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log('  ! ' + String(e).slice(0, 300)));
const realFailed = failed.filter((f) => !/favicon/i.test(f.blockedReason || f.errorText || ''));
if (realFailed.length) {
  console.log(`network failed: ${realFailed.length}`);
  realFailed.slice(0, 5).forEach((f) => console.log('  x ' + (f.errorText || f.blockedReason)));
}

ws.close();
child.kill();
await sleep(200);
process.exit(0);
