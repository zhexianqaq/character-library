/**
 * 缩略图接口吞吐实测（真实并行客户端，不用 python 线程池）。
 * 用法：node tools/bench-api.mjs [packId]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7788';

const packId = Number(process.argv[2]) || 8;

const pack = await (await fetch(`${BASE}/api/packs/${packId}/media`)).json();
const ids = pack.items.map((m) => m.id);

// 缓存清理由调用方（bash）负责：沙箱把 fs.rm 换成了回收站 shim，脚本内删不动
async function run(label) {
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  const bufs = await Promise.all(
    ids.map((id) =>
      fetch(`${BASE}/t/${id}`)
        .then((r) => r.arrayBuffer())
        .catch(() => new ArrayBuffer(0))
    )
  );
  const ms = Date.now() - t0;
  const kb = Math.round(bufs.reduce((a, b) => a + b.byteLength, 0) / 1024);
  console.log(
    `${label}  ${ids.length} 张  ${String(ms).padStart(5)}ms  平均 ${(ms / ids.length).toFixed(0)}ms/张  ${kb}KB`
  );
  return ms;
}

console.log(`图包 ${packId}：${ids.length} 项（混合图片与视频）\n`);
await run('冷缓存 · 并发请求');

const t0 = Date.now();
await Promise.all(ids.map((id) => fetch(`${BASE}/t/${id}`).then((r) => r.arrayBuffer())));
console.log(`缓存命中          ${ids.length} 张  ${String(Date.now() - t0).padStart(5)}ms`);
console.log('');
