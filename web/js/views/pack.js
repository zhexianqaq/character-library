import { api } from '../api.js';
import { esc, fmtNum, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openLightbox } from '../components/lightbox.js';
import { openModal } from '../components/modal.js';
import { openContextMenu, openMenuAtPoint } from '../components/context-menu.js';
import { mediaMenu } from '../components/media-actions.js';
import { addMediaMenuItems } from '../components/media-picker.js';
import { bindDropUpload } from '../components/dropzone.js';
import { queue } from '../upload-queue.js';

/** 有拍摄月份就显示月份；没有就用创建日期 */
function packDateLabel(pack) {
  if (pack.month) return pack.month;
  const d = new Date(pack.createdAt || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function PackView(root, id) {
  const [pack, media] = await Promise.all([api.pack(id), api.packMedia(id)]);
  let items = media.items;

  root.innerHTML =
    topbarHtml({ back: true, sub: '', actions: `<button class="tb-btn" data-rename>编辑</button>` }) +
    `<main class="page">
       <div class="toolbar">
         <div style="min-width:0">
           <div class="crumb"><a href="/c/${pack.character.id}" data-link>${esc(pack.character.name)}</a></div>
           <div class="title-row">
             <h1 class="page-title" data-title>${esc(pack.title)}</h1>
             <span class="pack-date" data-date>${esc(packDateLabel(pack))}</span>
           </div>
         </div>
         <span class="spacer"></span>
         <span class="count" data-count></span>
         <button class="tb-btn" data-add-media>＋ 添加素材</button>
       </div>
       <div class="masonry" data-masonry></div>
     </main>`;

  bindTopbar(root);

  const holder = root.querySelector('[data-masonry]');
  const titleEl = root.querySelector('[data-title]');
  const dateEl = root.querySelector('[data-date]');
  const countEl = root.querySelector('[data-count]');
  const addBtn = root.querySelector('[data-add-media]');

  function syncCount() {
    countEl.textContent = `${fmtNum(items.length)} 项${pack.counts && pack.counts.video ? ` · ${pack.counts.video} 个视频` : ''}`;
  }

  function paintMedia() {
    syncCount();
    holder.innerHTML = '';
    if (!items.length) {
      holder.innerHTML =
        '<div class="empty" style="flex:1"><b>这个图包是空的</b>点右上角「添加素材」，从已有素材里挑，或者把文件拖进来</div>';
      return;
    }
    requestAnimationFrame(() => {
      renderMasonry(holder, items, (i) => openLightbox(items, i), {
        onContext: (e, item) =>
          mediaMenu(e, item, {
            characterId: pack.character.id,
            onOpen: () => openLightbox(items, items.findIndex((x) => x.id === item.id)),
            onChange: reload,
          }),
      });
    });
  }

  async function reload() {
    try {
      const [nextPack, nextMedia] = await Promise.all([api.pack(id), api.packMedia(id)]);
      pack.title = nextPack.title;
      pack.month = nextPack.month;
      pack.counts = nextPack.counts;
      titleEl.textContent = nextPack.title;
      dateEl.textContent = packDateLabel(nextPack);
      items = nextMedia.items;
      paintMedia();
    } catch (err) {
      toast(err.message || '刷新失败');
    }
  }

  function addMediaItems() {
    return addMediaMenuItems({
      charId: pack.character.id,
      charName: pack.character.name,
      packId: pack.id,
      packTitle: pack.title,
      onUpload: () => pickFiles(),
      onDone: reload,
    });
  }

  function openAddMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenuAtPoint(Math.min(window.innerWidth - 16, r.right), r.bottom + 6, addMediaItems());
  }

  /** 上传到当前图包 */
  function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*';
    input.style.display = 'none';
    root.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;
      const n = queue.enqueue(files, {
        charId: pack.character.id,
        charName: pack.character.name,
        packId: pack.id,
        packTitle: pack.title,
        category: pack.category || null,
      });
      toast(n ? `已加入上传队列 ${n} 个文件 · 点右下角看进度` : '这些文件已经在队列里了');
    });
    input.click();
  }

  addBtn.addEventListener('click', () => openAddMenu(addBtn));

  // 传完自动刷新这一页
  queue.onIdle = () => {
    if (!root.isConnected || !root.querySelector('.page')) return;
    reload();
  };

  bindDropUpload(root.querySelector('.page'), () => ({
    charId: pack.character.id,
    charName: pack.character.name,
    packId: pack.id,
    packTitle: pack.title,
    category: pack.category || null,
  }));

  // 空白处右键
  root.querySelector('.page').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return;
    openContextMenu(e, [
      { label: '添加素材', hint: '4 种来源', children: addMediaItems() },
      { label: '编辑图包', onClick: () => root.querySelector('[data-rename]').click() },
      { label: '编辑标签', onClick: editTags },
      { label: '打开本地文件夹', onClick: () => api.reveal('pack', pack.id).catch(() => toast('目录已丢失')) },
    ]);
  });

  root.querySelector('[data-rename]').addEventListener('click', async () => {
    const v = await openModal({
      title: '编辑图包',
      fields: [
        { name: 'title', label: '名称', value: pack.title, required: true },
        {
          name: 'month',
          label: '拍摄日期（可选）',
          type: 'month',
          value: pack.month || '',
          hint: '留空则显示创建日期',
        },
      ],
      submitText: '保存',
    });
    if (!v) return;
    try {
      const saved = await api.updatePack(id, { title: v.title, month: v.month || null });
      pack.title = saved.title;
      pack.month = saved.month;
      pack.createdAt = saved.createdAt;
      titleEl.textContent = saved.title;
      dateEl.textContent = packDateLabel(pack);
      document.title = `${saved.title} · 资料库`;
      toast('已保存');
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });

  async function editTags() {
    const { openTagPicker } = await import('../components/tag-picker.js');
    const next = await openTagPicker({ title: '编辑图包标签', selected: pack.tags || [] });
    if (!next) return;
    await api.updatePack(pack.id, { tags: next });
    pack.tags = next;
    toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
  }

  paintMedia();
  document.title = `${pack.title} · 资料库`;
}
