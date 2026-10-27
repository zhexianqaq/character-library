import { filesFromDataTransfer, queue } from '../upload-queue.js';
import { importPaths } from '../api.js';
import { esc, toast } from '../util.js';

/**
 * 给页面挂「拖文件进来就上传」。
 * getTarget() 返回 { charId, charName, packId, packTitle, category }，返回 null 表示这页不收文件。
 * 遮罩只在拖拽期间存在，不做常驻 DOM，视图切走也不会留残留。
 */

/**
 * 桌面壳拖进来的路径：走服务端「从路径导入」。
 * 这是唯一能删掉源文件的通道 —— 浏览器上传只给字节，不知道文件在哪。
 */
async function importFromPaths(target, paths) {
  if (!paths || !paths.length) return;
  toast(`正在导入 ${paths.length} 项…`);
  try {
    const res = await importPaths({
      paths,
      charId: target.charId,
      packId: target.packId || null,
      category: target.category || null,
    });
    const bits = [];
    if (res.added) bits.push(`入库 ${res.added} 个`);
    if (res.removed && res.removed.length) bits.push(`删源 ${res.removed.length} 项`);
    if (res.kept && res.kept.length) bits.push(`保留 ${res.kept.length} 项`);
    if (res.skipped && res.skipped.length) bits.push(`跳过 ${res.skipped.length} 项`);
    toast(bits.join(' · ') || '没有可导入的内容');
    // 让当前视图重新拉数据，新素材立刻出现
    window.dispatchEvent(new CustomEvent('app:route'));
  } catch (err) {
    toast(err && err.message ? err.message : '导入失败');
  }
}

// 全局兜底：拖到顶栏或窗口空白处松手时，别让浏览器直接打开这个文件
let guarded = false;
function guardWindow() {
  if (guarded) return;
  guarded = true;
  const stop = (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  };
  document.addEventListener('dragover', stop);
  document.addEventListener('drop', stop);
}

export function bindDropUpload(el, getTarget, opts = {}) {
  if (!el) return () => {};
  guardWindow();
  let depth = 0;
  let mask = null;

  const drop = async (files) => {
    if (typeof opts.onFiles === 'function') {
      await opts.onFiles(files);
      return;
    }
    const target = getTarget && getTarget();
    if (!target) return;
    const n = queue.enqueue(files, target);
    toast(n ? `已加入上传队列 ${n} 个文件 · 点右下角看进度` : '这些文件已经在队列里了');
  };

  const hide = () => {
    depth = 0;
    if (mask) {
      mask.classList.remove('on');
      const node = mask;
      mask = null;
      setTimeout(() => node.remove(), 180);
    }
  };

  const show = () => {
    if (mask) return;
    const target = getTarget && getTarget();
    if (!target) return;
    const hint =
      typeof opts.hint === 'function'
        ? opts.hint(target)
        : target.packTitle
          ? `传进「${esc(target.packTitle)}」`
          : '按文件名里的日期自动归包，没日期的进「未分类」';
    mask = document.createElement('div');
    mask.className = 'drop-mask';
    mask.innerHTML = `<div class="drop-card">
        <div class="drop-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v12" /><path d="m6 11 6 6 6-6" /><path d="M5 20h14" />
          </svg>
        </div>
        <b>松手开始上传</b>
        <span>${hint}</span>
        ${opts.noArchive ? '' : '<em class="drop-tip">压缩包（zip / rar / 7z）会自动解压</em>'}
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask && mask.classList.add('on'));
  };

  const hasFiles = (e) => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    return Array.from(dt.types || []).includes('Files');
  };

  const onEnter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    show();
  };
  const onOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = (e) => {
    if (!hasFiles(e)) return;
    depth -= 1;
    if (depth <= 0) hide();
  };
  const onDrop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    let files = [];
    try {
      files = await filesFromDataTransfer(e.dataTransfer);
    } catch {
      files = Array.from(e.dataTransfer.files || []);
    }
    if (!files.length) return;
    await drop(files);
  };

  el.addEventListener('dragenter', onEnter);
  el.addEventListener('dragover', onOver);
  el.addEventListener('dragleave', onLeave);
  el.addEventListener('drop', onDrop);

  // 桌面壳把拖进来的真实路径交给我们（浏览器里这个函数永远不存在）
  const onNativeDrop = (paths) => {
    const target = getTarget && getTarget();
    if (!target) return;
    if (typeof opts.onPaths === 'function') {
      opts.onPaths(paths, target);
      return;
    }
    importFromPaths(target, paths);
  };
  window.__amsDrop = onNativeDrop;

  return () => {
    el.removeEventListener('dragenter', onEnter);
    el.removeEventListener('dragover', onOver);
    el.removeEventListener('dragleave', onLeave);
    el.removeEventListener('drop', onDrop);
    // 只有自己还是「当前那一个」时才清，避免把后来视图挂的桥抹掉
    if (window.__amsDrop === onNativeDrop) window.__amsDrop = null;
    hide();
  };
}
