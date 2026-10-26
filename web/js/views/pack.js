import { api } from '../api.js';
import { esc, fmtNum, fadeIn, toast } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';
import { openLightbox } from '../components/lightbox.js';
import { openModal, confirmDialog } from '../components/modal.js';

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
  const items = media.items;

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
         <span class="count">${fmtNum(items.length)} 项${
           pack.counts && pack.counts.video ? ` · ${pack.counts.video} 个视频` : ''
         }</span>
       </div>
       <div class="masonry" data-masonry></div>
     </main>`;

  bindTopbar(root);

  const holder = root.querySelector('[data-masonry]');
  const titleEl = root.querySelector('[data-title]');
  const dateEl = root.querySelector('[data-date]');

  if (!items.length) {
    holder.innerHTML = '<div class="empty" style="flex:1"><b>这个图包是空的</b>回到角色页上传文件，或把媒体移动进来</div>';
  } else {
    requestAnimationFrame(() => {
      renderMasonry(holder, items, (i) => openLightbox(items, i));
    });
  }

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

  document.title = `${pack.title} · 资料库`;
}
