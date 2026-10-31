/**
 * 进行中的操作。关窗口时先排空这些，再 checkpoint，最后才退出。
 *
 * 不依赖数据库：checkpoint 由调用方在「全部排空」的回调里做。
 */

const jobs = new Map();
let seq = 0;
let shuttingDown = false;
let checkpointing = false;
let exitQueued = false;
let exitFn = null;

function snapshot() {
  return {
    shuttingDown,
    checkpointing,
    pending: [...jobs.values()],
  };
}

export function isShuttingDown() {
  return shuttingDown;
}

export function inflightStatus() {
  return snapshot();
}

function insert(kind, label, { allowDuringShutdown = false } = {}) {
  if (shuttingDown && !allowDuringShutdown) {
    const err = new Error('服务正在退出，已不再接受新的操作');
    err.status = 503;
    err.code = 'SHUTTING_DOWN';
    throw err;
  }
  seq += 1;
  const id = `${kind}-${seq}`;
  jobs.set(id, {
    id,
    kind,
    label: String(label || kind),
    startedAt: new Date().toISOString(),
  });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    jobs.delete(id);
    pump();
  };
}

/** 登记一项进行中的操作。退出过程中再登记会抛 503。返回结束函数，可重复调用。 */
export function beginJob(kind, label) {
  return insert(kind, label);
}

/** checkpoint 自己也要出现在等待列表里，所以允许在退出过程中登记。 */
export function beginCheckpointJob(label) {
  checkpointing = true;
  return insert('checkpoint', label, { allowDuringShutdown: true });
}

function pump() {
  if (!shuttingDown || exitQueued || jobs.size > 0) return;
  exitQueued = true;
  const fn = exitFn;
  exitFn = null;
  if (typeof fn === 'function') setTimeout(fn, 30);
}

/**
 * 开始退出：不再接受新的登记。没有进行中的操作时，大约 30ms 后调用 exitFn（先让 HTTP 响应发出去）。
 * 还有操作时，等最后一项结束再调用。重复调用只刷新状态，不会排两次退出。
 */
export function beginShutdown(onDrained) {
  shuttingDown = true;
  if (!exitQueued && typeof onDrained === 'function' && !exitFn) exitFn = onDrained;
  pump();
  return snapshot();
}

/** 测试用：清掉模块状态。 */
export function resetInflightForTests() {
  jobs.clear();
  seq = 0;
  shuttingDown = false;
  checkpointing = false;
  exitQueued = false;
  exitFn = null;
}
