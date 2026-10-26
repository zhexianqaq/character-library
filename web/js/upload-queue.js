import { uploadMedia } from './api.js';

/**
 * 上传队列（全局单例）。
 *
 * 为什么一个文件一个请求：只有这样才能给每个文件独立的进度和独立的失败原因
 * （重复文件、格式不支持都是按文件跳过的）。并发 3 个，避免机械盘上 seek 打架。
 */

const CONCURRENCY = 3;

const tasks = [];
const listeners = new Set();
let seq = 0;
let running = 0;
let frame = 0;
let wasActive = false;

/** 队列外部只读快照 */
export function snapshot() {
  let total = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let waiting = 0;
  let uploading = 0;
  let bytesTotal = 0;
  let bytesLoaded = 0;
  let speed = 0;
  const now = Date.now();

  for (const t of tasks) {
    total += 1;
    bytesTotal += t.size || 0;
    bytesLoaded += t.state === 'done' ? t.size || 0 : Math.min(t.loaded || 0, t.size || 0);
    if (t.state === 'done') done += 1;
    else if (t.state === 'error') failed += 1;
    else if (t.state === 'skipped') skipped += 1;
    else if (t.state === 'uploading') uploading += 1;
    else waiting += 1;
    if (t.state === 'uploading' && t.startedAt && t.loaded) {
      speed += (t.loaded / Math.max(1, now - t.startedAt)) * 1000;
    }
  }

  const active = uploading + waiting;
  const finished = done + failed + skipped;
  return {
    total,
    done,
    failed,
    skipped,
    waiting,
    uploading,
    active,
    finished,
    bytesTotal,
    bytesLoaded,
    percent: bytesTotal ? Math.min(1, bytesLoaded / bytesTotal) : finished && total ? 1 : 0,
    speed,
    idle: total > 0 && active === 0,
  };
}

function notify() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error('[upload] 监听器异常', err);
      }
    }
    // 从「有任务在跑」变成「全停了」，通知一次，页面借此刷新
    if (wasActive && snap.idle && typeof queue.onIdle === 'function') {
      try {
        queue.onIdle(snap);
      } catch (err) {
        console.error('[upload] onIdle 异常', err);
      }
    }
    wasActive = snap.active > 0;
  });
}

function kindOf(file) {
  const t = String(file.type || '');
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  return /\.(png|jpe?g|webp|gif|bmp|avif|heic|tiff?)$/i.test(file.name || '') ? 'image' : 'video';
}

function isSameFile(a, b) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

function pump() {
  while (running < CONCURRENCY) {
    const next = tasks.find((t) => t.state === 'waiting');
    if (!next) break;
    start(next);
  }
}

function start(t) {
  t.state = 'uploading';
  t.loaded = 0;
  t.startedAt = Date.now();
  t.error = '';
  running += 1;
  notify();

  uploadMedia(t.charId, [t.file], {
    packId: t.packId,
    category: t.category,
    onProgress: (loaded, total) => {
      t.loaded = loaded;
      t.total = total;
      notify();
    },
  })
    .then((res) => {
      const added = Number(res && res.added) || 0;
      const skipped = (res && res.skipped) || [];
      if (added > 0) {
        t.state = 'done';
        t.loaded = t.size;
        t.ids = (res && res.ids) || [];
        t.note = skipped.length ? skipped[0].reason : '';
      } else {
        t.state = 'skipped';
        t.reason = (skipped[0] && skipped[0].reason) || '未导入';
      }
    })
    .catch((err) => {
      t.state = 'error';
      t.error = err && err.message ? err.message : '上传失败';
    })
    .finally(() => {
      running -= 1;
      t.endedAt = Date.now();
      pump();
      notify();
    });
}

export const queue = {
  /** 全部任务结束后回调（视图里覆盖这个槽位即可，不用订阅/退订） */
  onIdle: null,

  enqueue(files, { charId, charName = '', packId = null, packTitle = '', category = null } = {}) {
    if (!charId) return 0;
    let n = 0;
    for (const file of files || []) {
      if (!file || !file.size) continue;
      if (tasks.some((t) => t.state !== 'done' && isSameFile(t.file, file))) continue;
      const kind = kindOf(file);
      seq += 1;
      tasks.push({
        id: seq,
        file,
        name: file.name || '未命名',
        size: file.size || 0,
        kind,
        previewUrl: kind === 'image' && typeof URL !== 'undefined' ? URL.createObjectURL(file) : '',
        charId,
        charName,
        packId,
        packTitle,
        category,
        state: 'waiting',
        loaded: 0,
        error: '',
        reason: '',
        note: '',
        ids: [],
      });
      n += 1;
    }
    if (n) {
      pump();
      notify();
    }
    return n;
  },

  list() {
    return tasks;
  },

  subscribe(fn) {
    listeners.add(fn);
    fn(snapshot());
    return () => listeners.delete(fn);
  },

  /** 清掉已完成 / 已跳过 / 失败的记录 */
  clearFinished() {
    let i = tasks.length;
    while (i--) {
      const t = tasks[i];
      if (t.state === 'done' || t.state === 'skipped' || t.state === 'error') {
        if (t.previewUrl) URL.revokeObjectURL(t.previewUrl);
        tasks.splice(i, 1);
      }
    }
    notify();
  },

  remove(id) {
    const i = tasks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = tasks[i];
    if (t.state === 'uploading') return;
    if (t.previewUrl) URL.revokeObjectURL(t.previewUrl);
    tasks.splice(i, 1);
    notify();
  },

  retry(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.state === 'uploading' || t.state === 'waiting') return;
    t.state = 'waiting';
    t.loaded = 0;
    t.error = '';
    t.reason = '';
    pump();
    notify();
  },

  retryFailed() {
    let n = 0;
    for (const t of tasks) {
      if (t.state === 'error') {
        t.state = 'waiting';
        t.loaded = 0;
        t.error = '';
        n += 1;
      }
    }
    if (n) {
      pump();
      notify();
    }
    return n;
  },

  /** 进入上传页时把「上一个视图的 onIdle」清掉，避免误刷新别的页面 */
  detachOnIdle() {
    queue.onIdle = null;
  },
};

/** 从拖拽事件里取出文件，支持文件夹递归 */
export async function filesFromDataTransfer(dt) {
  const items = dt && dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) return dt && dt.files ? Array.from(dt.files) : [];

  const out = [];
  const walk = async (entry) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };

  for (const entry of entries) await walk(entry);
  // 有些浏览器（拖的是文本/链接）拿不到 entry，回落到 files
  return out.length ? out : dt && dt.files ? Array.from(dt.files) : [];
}
