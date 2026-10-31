/**
 * 关窗口排空：进行中的操作没结束之前，shutdown 不退出；
 * 空闲时 shutdown 会在 checkpoint 之后退出。
 *
 * 只用临时目录，不碰真实资料库。
 *   node tools/shutdown-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginJob,
  beginShutdown,
  inflightStatus,
  resetInflightForTests,
} from '../server/src/inflight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `cl-shutdown-${Date.now()}`);
const DATA = path.join(TMP, 'data');
const CACHE = path.join(TMP, 'cache');
const PORT = 7600 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(url, opts) {
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
const jpost = (u, b) =>
  jfetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

function startServer() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      CL_DATA_DIR: DATA,
      CL_CACHE_DIR: CACHE,
      CL_SHUTDOWN_TEST: '1',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/shutdown-status`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  return false;
}

function portOpen() {
  return fetch(`${BASE}/api/shutdown-status`, { signal: AbortSignal.timeout(400) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function unit() {
  resetInflightForTests();
  let exited = 0;
  const end = beginJob('import', '正在从磁盘导入');
  const snap = beginShutdown(() => {
    exited += 1;
  });
  check('有操作时登记退出，但先不收尾', snap.shuttingDown === true && snap.pending.length === 1 && exited === 0);
  check('状态里能看到正在做什么', snap.pending[0].label === '正在从磁盘导入');
  let rejected = false;
  try {
    beginJob('thumb', '正在生成缩略图');
  } catch (err) {
    rejected = err.code === 'SHUTTING_DOWN';
  }
  check('退出过程中不再接受新操作', rejected);
  end();
  await sleep(80);
  check('最后一项结束后才收尾，且只收尾一次', exited === 1, `exited=${exited}`);
  resetInflightForTests();
}

async function main() {
  await unit();
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(CACHE, { recursive: true });
  const child = startServer();
  let log = '';
  child.stdout.on('data', (d) => {
    log += d;
  });
  child.stderr.on('data', (d) => {
    log += d;
  });
  if (!(await waitServer())) {
    check('服务起来', false, log.slice(-400));
    child.kill();
    return;
  }
  check('空闲时没有进行中的操作', (await jfetch('/api/shutdown-status')).body.pending.length === 0);

  const hold = await jpost('/api/shutdown-test-hold');
  const busy = await jfetch('/api/shutdown-status');
  check(
    '占用之后状态里有这一项',
    hold.status === 200 && busy.body.pending.length === 1 && busy.body.pending[0].label === '测试占用',
    JSON.stringify(busy.body.pending)
  );

  const shut = await jpost('/api/shutdown');
  await sleep(400);
  const stillUp = await portOpen();
  check(
    '还有操作时 shutdown 不退出',
    shut.status === 200 && shut.body.shuttingDown === true && shut.body.pending.length === 1 && stillUp,
    `up=${stillUp}`
  );

  const blocked = await jpost('/api/shelves', { name: '不该建' });
  check('退出过程中新的写操作被拒绝', blocked.status === 503 && blocked.body.code === 'SHUTTING_DOWN', `HTTP ${blocked.status}`);

  const t0 = Date.now();
  await jpost('/api/shutdown-test-release');
  let gone = false;
  for (let i = 0; i < 40; i += 1) {
    if (!(await portOpen())) {
      gone = true;
      break;
    }
    await sleep(100);
  }
  check('操作结束后才退出', gone, `${Date.now() - t0}ms`);
  if (!gone) child.kill();
}

try {
  await main();
} catch (err) {
  check('测试执行中断', false, String(err && err.message ? err.message : err));
} finally {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n结果：${results.length - fail} 通过 / ${fail} 失败\n`);
  process.exitCode = fail ? 1 : 0;
}
