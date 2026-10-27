import { api } from '../api.js';
import { esc, fmtNum, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { confirmDialog } from '../components/modal.js';

/** 动作 → 人话 */
const ACTION_LABEL = {
  'pack.create': '新建图包',
  'pack.rename': '图包改名',
  'pack.delete': '删除图包',
  'pack.dissolve': '解散图包',
  'media.add': '新增素材',
  'media.move': '移动素材',
  'media.delete': '删除素材',
  'media.alias': '改显示名',
  'character.create': '新建条目',
  'character.rename': '条目改名',
  'character.delete': '删除条目',
  'dir.prune': '收空目录',
};

const STATUS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待同步' },
  { value: 'failed', label: '失败' },
  { value: 'done', label: '已完成' },
];

const statusText = { pending: '待同步', failed: '失败', done: '已完成', canceled: '已取消' };

/** 从 payload 里挑一句能看懂的摘要 */
function summarize(op) {
  const p = op.payload || {};
  const n = (arr) => (Array.isArray(arr) ? arr.length : 0);
  switch (op.action) {
    case 'pack.create':
      return p.title ? `「${p.title}」` : '';
    case 'pack.rename':
      return p.from || p.to ? `「${p.from || '?'}」→「${p.to || '?'}」` : '';
    case 'pack.delete':
    case 'pack.dissolve':
      return `${p.title ? `「${p.title}」` : ''}${n(p.mediaIds) || n(p.items) ? ` · ${n(p.mediaIds) || n(p.items)} 个素材` : ''}`;
    case 'media.add':
      return `${n(p.ids)} 个文件`;
    case 'media.move':
      return `${n(p.ids)} 个素材${p.title ? ` → 「${p.title}」` : ''}`;
    case 'media.delete':
      return `${n(p.items) || n(p.paths)} 个文件`;
    case 'dir.prune':
      return `${n(p.dirs)} 个目录`;
    case 'character.create':
    case 'character.rename':
    case 'character.delete':
      return p.name ? `「${p.name}」` : '';
    default:
      return '';
  }
}

const two = (n) => String(n).padStart(2, '0');
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/**
 * 操作记录：每次动磁盘 / 待同步的改动都在这。
 * 长住数据，默认不带筛选；可以按状态和关键词翻，也能手动归档一年前的。
 */
export async function OpsView(root) {
  const state = { status: '', q: '', offset: 0, limit: 100, total: 0, items: [] };

  root.innerHTML =
    topbarHtml({
      back: true,
      title: '操作记录',
      sub: '',
      actions: `<button class="tb-btn" data-full>全量校验</button><button class="tb-btn" data-archive>归档旧记录</button>`,
    }) +
    `<main class="page">
       <div class="toolbar">
         <div class="segmented" data-status>
           ${STATUS.map(
             (s) => `<button class="${s.value === '' ? 'on' : ''}" data-s="${s.value}">${s.label}</button>`
           ).join('')}
         </div>
         <span class="spacer"></span>
         <label class="search filter-search">
           <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
             <circle cx="7" cy="7" r="4.6"/><path d="M10.6 10.6L14 14"/>
           </svg>
           <input type="search" placeholder="搜动作 / 包名 / 原因" autocomplete="off" spellcheck="false" />
         </label>
         <span class="count" data-count></span>
       </div>
       <div class="op-list" data-list></div>
       <div class="op-more" data-more hidden><button class="tb-btn">加载更多</button></div>
     </main>`;

  bindTopbar(root);

  const listEl = root.querySelector('[data-list]');
  const moreEl = root.querySelector('[data-more]');

  function paintRows(append = false) {
    if (!state.items.length) {
      listEl.innerHTML = '<div class="empty"><b>还没有记录</b>前端每次改动都会记在这里</div>';
      moreEl.hidden = true;
      return;
    }
    const html = state.items
      .map((op) => {
        const label = ACTION_LABEL[op.action] || op.action;
        const sum = summarize(op);
        const bad = op.status === 'failed';
        return `<div class="op-row" data-st="${esc(op.status)}">
          <span class="op-time">${fmtTime(op.created_at)}</span>
          <span class="op-act">${esc(label)}</span>
          <span class="op-main" title="${esc(sum)}">${esc(sum)}</span>
          <span class="op-st ${bad ? 'is-bad' : op.status === 'pending' ? 'is-wait' : ''}">${
            statusText[op.status] || op.status
          }</span>
          ${op.reason ? `<span class="op-why" title="${esc(op.reason)}">${esc(op.reason)}</span>` : ''}
        </div>`;
      })
      .join('');
    if (append) listEl.insertAdjacentHTML('beforeend', html);
    else listEl.innerHTML = html;
    moreEl.hidden = state.items.length >= state.total;
  }

  async function load(append = false) {
    if (!append) {
      state.offset = 0;
      listEl.innerHTML = '<div class="empty"><b>加载中…</b></div>';
    }
    const r = await api.opsList({
      limit: state.limit,
      offset: state.offset,
      status: state.status,
      q: state.q,
    });
    state.total = r.total;
    state.items = append ? [...state.items, ...r.items] : r.items;
    state.offset = state.items.length;
    root.querySelector('[data-count]').textContent = r.total ? `${fmtNum(r.total)} 条` : '';
    paintRows(append);
  }

  root.querySelector('[data-status]').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    state.status = b.dataset.s;
    root.querySelectorAll('[data-status] button').forEach((x) => x.classList.toggle('on', x === b));
    load().catch((err) => toast(err.message || '加载失败'));
  });

  const input = root.querySelector('.filter-search input');
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = input.value.trim();
      load().catch(() => {});
    }, 240);
  });

  moreEl.querySelector('button').addEventListener('click', () => {
    load(true).catch((err) => toast(err.message || '加载失败'));
  });

  // 兜底：只在手动动过磁盘（资源管理器里改名 / 移动）时才需要
  root.querySelector('[data-full]').addEventListener('click', async () => {
    try {
      const p = await api.syncPreview();
      const g = p.packs || {};
      const total = (p.filesMoved || 0) + (p.loose && p.loose.filesMoved ? p.loose.filesMoved : 0);
      if (!g.renamed && !g.merged && !total && !(p.loose && p.loose.items)) {
        toast('全量校验：磁盘和数据库一致');
        return;
      }
      const ok = await confirmDialog(
        '全量校验并修复？',
        `会扫一遍整个库（比增量慢）：改名 ${g.renamed || 0} 个、合并 ${g.merged || 0} 个、` +
          `移动 ${total} 个文件。不会删除任何文件，空目录才会被回收。`,
        '开始校验'
      );
      if (!ok) return;
      const r = await api.syncRun();
      toast(`全量校验完成：改名 ${r.packs.renamed} · 合并 ${r.packs.merged} · 移动 ${r.filesMoved}`);
      await load();
    } catch (err) {
      toast(err.message || '校验失败');
    }
  });

  root.querySelector('[data-archive]').addEventListener('click', async () => {
    const ok = await confirmDialog(
      '归档旧记录？',
      '只会删掉「已完成且校验通过」超过 365 天的记录，待同步和失败的一条不动。',
      '归档'
    );
    if (!ok) return;
    try {
      const r = await api.opsArchive(365);
      toast(r.removed ? `已归档 ${r.removed} 条` : '没有需要归档的记录');
      await load();
    } catch (err) {
      toast(err.message || '归档失败');
    }
  });

  document.title = '操作记录 · 资料库';
  await load();
}
