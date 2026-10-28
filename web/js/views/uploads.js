import { queue, snapshot } from '../upload-queue.js';
import { esc, fmtBytes, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { bindDropUpload } from '../components/dropzone.js';
import { openModal } from '../components/modal.js';
import { api } from '../api.js';

const STATE_TEXT = {
  waiting: '等待中',
  uploading: '上传中',
  done: '已完成',
  skipped: '已跳过',
  error: '失败',
};

function pct(t) {
  if (t.state === 'done') return 100;
  const total = t.total || t.size || 0;
  return total ? Math.min(100, Math.round(((t.loaded || 0) / total) * 100)) : 0;
}

/** 所有角色，角色选择弹窗用 */
async function allCharacters() {
  const ov = await api.overview();
  const out = [];
  for (const shelf of ov.shelves || []) {
    try {
      const d = await api.shelfCharacters(shelf.id, { limit: 500 });
      for (const c of d.items || []) out.push({ id: c.id, name: c.name, shelfName: shelf.name });
    } catch {
      /* 单个库失败不影响其他 */
    }
  }
  return out;
}

/** 拖进来的文件往哪放：让用户挑一次角色 / 图包 */
async function askTarget(files) {
  const chars = await allCharacters();
  if (!chars.length) {
    toast('还没有角色 / 人物，先去建一个');
    return null;
  }
  const last = queue.list().filter((t) => t.charId).pop();

  const v = await openModal({
    title: `上传 ${files.length} 个文件`,
    description: '选好角色后可以再指定图包；不指定就按文件名里的日期自动归包。',
    fields: [
      {
        name: 'charId',
        label: '角色 / 人物',
        type: 'select',
        required: true,
        value: last ? String(last.charId) : String(chars[0].id),
        options: chars.map((c) => ({ value: String(c.id), label: `${c.shelfName} / ${c.name}` })),
      },
      {
        name: 'packId',
        label: '图包',
        type: 'select',
        options: [{ value: '', label: '自动按日期归包' }],
        value: last && last.packId ? String(last.packId) : '',
        hint: '选一个图包，这批文件就全部传进这个图包',
      },
    ],
    onMount: (body) => {
      const charSel = body.querySelector('[name="charId"]');
      const packSel = body.querySelector('[name="packId"]');
      const fill = async () => {
        const keep = packSel.value;
        packSel.innerHTML = '<option value="">自动按日期归包</option>';
        try {
          const d = await api.packs(Number(charSel.value));
          for (const p of d.items || []) {
            const o = document.createElement('option');
            o.value = String(p.id);
            o.textContent = `${p.category ? `${p.category} / ` : ''}${p.title}`;
            packSel.appendChild(o);
          }
          packSel.value = keep;
        } catch {
          /* 角色可能刚被删 */
        }
      };
      charSel.addEventListener('change', fill);
      fill();
    },
    submitText: '加入队列',
  });
  if (!v) return null;

  const charId = Number(v.charId);
  const packId = v.packId ? Number(v.packId) : null;
  const c = chars.find((x) => x.id === charId);
  let packTitle = '';
  if (packId) {
    try {
      const p = await api.pack(packId);
      packTitle = p.title || '';
    } catch {
      /* 图包信息拿不到不影响上传 */
    }
  }
  return { charId, charName: c ? c.name : '', packId, packTitle, category: null };
}

export async function UploadsView(root) {
  root.innerHTML =
    topbarHtml({
      back: true,
      title: '上传队列',
      sub: '',
      actions: `<button class="tb-btn" data-pick>选择文件</button><button class="tb-btn" data-clear>清空已完成</button>`,
    }) +
    `<main class="page up-page">
       <div class="up-summary" data-summary></div>
       <div class="up-list" data-list></div>
       <div class="up-empty" data-empty hidden>
         <b>队列是空的</b>
         <span>把图片 / 视频 / 压缩包（或整个文件夹）拖到这里，也可以点右上角「选择文件」</span>
       </div>
       <div class="up-foot">拖动文件到本页任意位置即可加入队列 · 上传在后台进行，可以随时切到别的页面继续浏览</div>
     </main>`;

  bindTopbar(root);
  const pageEl = root.querySelector('.up-page');
  const listEl = root.querySelector('[data-list]');
  const summaryEl = root.querySelector('[data-summary]');
  const emptyEl = root.querySelector('[data-empty]');
  const rows = new Map();

  async function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,.zip,.rar,.7z,.tgz,.tar,.tar.gz';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;
      const target = await askTarget(files);
      if (!target) return;
      queue.enqueue(files, target);
      toast(`已加入 ${files.length} 个文件`);
    });
    input.click();
  }

  bindDropUpload(
    document.body,
    () => ({ drop: true }),
    {
      hint: () => '松手后选一下上传到哪个角色 / 图包',
      onFiles: async (files) => {
        const target = await askTarget(files);
        if (!target) return;
        queue.enqueue(files, target);
        toast(`已加入 ${files.length} 个文件`);
      },
    }
  );

  function rowRef(t) {
    const el = document.createElement('div');
    el.className = 'up-row';
    el.dataset.id = String(t.id);
    el.innerHTML = `
      <div class="up-thumb">${
        t.previewUrl
          ? `<img src="${t.previewUrl}" alt="" />`
          : `<span>${t.kind === 'video' ? '▶' : t.kind === 'archive' ? 'ZIP' : 'IMG'}</span>`
      }</div>
      <div class="up-main">
        <div class="up-line">
          <span class="up-name" title="${esc(t.name)}">${esc(t.name)}</span>
          <span class="up-size">${fmtBytes(t.size)}</span>
        </div>
        <div class="up-sub"></div>
        <div class="up-track"><i></i></div>
      </div>
      <div class="up-status"></div>`;
    return {
      el,
      sub: el.querySelector('.up-sub'),
      track: el.querySelector('.up-track'),
      bar: el.querySelector('.up-track i'),
      status: el.querySelector('.up-status'),
    };
  }

  function update(ref, t) {
    const p = pct(t);
    ref.el.dataset.state = t.state;
    ref.bar.style.width = `${t.state === 'skipped' || t.state === 'error' ? 100 : p}%`;
    ref.track.classList.toggle('is-err', t.state === 'error');
    ref.track.classList.toggle('is-skip', t.state === 'skipped');

    const target = [t.charName, t.packTitle].filter(Boolean).join(' / ');
    ref.sub.textContent = target ? `→ ${target}` : '';
    if (t.state === 'error') ref.sub.textContent = `→ ${t.error}`;
    else if (t.state === 'skipped') ref.sub.textContent = `→ ${t.reason}${target ? `（目标 ${target}）` : ''}`;
    else if (t.state === 'done' && t.note) ref.sub.textContent = `→ ${t.note}`;

    if (t.state === 'uploading') ref.status.textContent = t.unpacking ? '解压中…' : `${STATE_TEXT.uploading} ${p}%`;
    else ref.status.textContent = STATE_TEXT[t.state] || '';
    ref.status.className = `up-status is-${t.state}`;
  }

  function render() {
    const list = queue.list();
    const alive = new Set(list.map((t) => t.id));
    for (const [id, ref] of rows) {
      if (!alive.has(id)) {
        ref.el.remove();
        rows.delete(id);
      }
    }
    for (const t of list) {
      let ref = rows.get(t.id);
      if (!ref) {
        ref = rowRef(t);
        rows.set(t.id, ref);
        listEl.appendChild(ref.el);
      }
      update(ref, t);
    }
    emptyEl.hidden = list.length > 0;
    listEl.hidden = list.length === 0;
  }

  function renderSummary(snap) {
    if (!snap.total) {
      summaryEl.innerHTML = '';
      summaryEl.hidden = true;
      return;
    }
    summaryEl.hidden = false;
    const overall = Math.round(snap.percent * 100);
    const parts = [`已上传 <b>${snap.bytesLoaded ? fmtBytes(snap.bytesLoaded) : '0 B'}</b> / ${fmtBytes(snap.bytesTotal)}`];
    if (snap.speed > 1) parts.push(`${fmtBytes(snap.speed)}/s`);
    if (snap.active && snap.speed > 1024) {
      const left = Math.max(1, Math.round((snap.bytesTotal - snap.bytesLoaded) / snap.speed));
      parts.push(left > 90 ? `剩余约 ${Math.round(left / 60)} 分钟` : `剩余约 ${left} 秒`);
    }
    if (snap.done) parts.push(`完成 ${snap.done}`);
    if (snap.failed) parts.push(`失败 ${snap.failed}`);
    if (snap.skipped) parts.push(`跳过 ${snap.skipped}`);

    const head = snap.active
      ? `正在上传 ${snap.uploading} 个文件 · 共 ${snap.total} 个`
      : snap.failed
        ? `上传结束，${snap.failed} 个失败`
        : snap.done === 0 && snap.skipped
          ? `${snap.skipped} 个文件被跳过`
          : `上传完成，共 ${snap.done} 个`;

    // 全是重复文件时别用满格黑色，看着像成功入库了
    const tone = snap.active ? '' : snap.failed ? 'is-err' : snap.done === 0 ? 'is-skip' : '';

    summaryEl.innerHTML = `
      <div class="up-sum-head">
        <b>${head}</b>
        <span>${parts.join(' · ')}</span>
      </div>
      <div class="up-sum-track ${tone}"><i style="width:${overall}%"></i></div>
      ${snap.failed ? '<button class="tb-btn up-retry" data-retry>重试失败项</button>' : ''}`;
    const retry = summaryEl.querySelector('[data-retry]');
    if (retry) {
      retry.addEventListener('click', () => {
        const n = queue.retryFailed();
        toast(n ? `已重排 ${n} 个文件` : '没有可重试的项');
      });
    }
  }

  let unsub = () => {};
  unsub = queue.subscribe((snap) => {
    if (!document.body.contains(pageEl)) {
      unsub();
      return;
    }
    render();
    renderSummary(snap);
  });

  root.querySelector('[data-pick]').addEventListener('click', pickFiles);
  root.querySelector('[data-clear]').addEventListener('click', () => {
    const snap = snapshot();
    if (!snap.finished) {
      toast('还没有可清空的记录');
      return;
    }
    if (snap.active) {
      toast('还有文件在上传，等传完再清');
      return;
    }
    queue.clearFinished();
  });

  document.title = '上传队列 · 资料库';
  return () => {
    unsub();
  };
}
