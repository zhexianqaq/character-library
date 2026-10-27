import { api } from '../api.js';
import { esc, fmtNum, fadeIn } from '../util.js';
import { topbarHtml, bindTopbar } from '../components/topbar.js';
import { renderMasonry } from '../components/masonry.js';

/**
 * 标签页：一个标签名下的全部内容。
 *
 * 三段 —— 条目 / 图包 / 素材。素材口径和服务端一致（自己的标签、所属条目名、
 * 所在图包的标签），所以「水淼」这种名字标签能同时看到人、她的包、和里面的图。
 * 素材只取最近 200 个，多了在标题右侧如实标出来。
 */
export async function TagView(root, rawName) {
  const name = String(rawName || '').trim();
  document.title = `#${name} · 资料库`;

  let data = null;
  try {
    data = await api.tag(name);
  } catch (err) {
    root.innerHTML =
      topbarHtml({ back: true, sub: '', actions: '' }) +
      `<main class="page"><div class="empty"><b>标签读取失败</b>${esc(err.message || '稍后再试')}</div></main>`;
    bindTopbar(root);
    return;
  }
  const counts = data.counts || { characters: 0, packs: 0, media: 0 };
  const chars = data.characters || [];
  const packs = data.packs || [];
  const media = data.media || [];
  const metaBits = [];
  if (counts.characters) metaBits.push(`${fmtNum(counts.characters)} 个条目`);
  if (counts.packs) metaBits.push(`${fmtNum(counts.packs)} 个图包`);
  if (counts.media) metaBits.push(`${fmtNum(counts.media)} 个素材`);

  const go = (path) => {
    history.pushState({ from: location.pathname + location.search }, '', path);
    window.dispatchEvent(new CustomEvent('app:route'));
  };

  const charCard = (c) => {
    const img = c.coverMediaId ? api.thumb(c.coverMediaId) : '';
    return `<a class="char-card" href="/c/${c.id}" data-link>
      <div class="cover">
        ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">待添加</div>'}
        <span class="badge">${fmtNum(c.mediaCount || 0)}</span>
      </div>
      <div class="info">
        <div class="name">${esc(c.name)}</div>
        <div class="sub">${esc((c.shelf && c.shelf.name) || '')} · ${fmtNum(c.packCount || 0)} 个图包</div>
      </div>
    </a>`;
  };

  const packCard = (p) => {
    const img = p.coverMediaId ? api.thumb(p.coverMediaId) : '';
    const comic = p.kind === 'comic';
    const unit = comic ? '页' : '项';
    const n = comic ? p.imageCount || 0 : p.mediaCount || 0;
    return `<div class="pack-card is-linked" data-pack="${p.id}">
      <a class="pack-hit" href="/p/${p.id}" data-link aria-label="${esc(p.title)}"></a>
      <div class="cover single">
        ${comic ? '<span class="kind-chip">漫画</span>' : ''}
        ${img ? `<img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '<div class="cover-empty">空</div>'}
        <span class="linked-from">${esc((p.shelf && p.shelf.name) || '其他库')}</span>
      </div>
      <div class="info">
        <div class="t">${esc(p.title)}</div>
        <div class="m">${esc((p.owner && p.owner.name) || '')} · ${fmtNum(n)} ${unit}</div>
      </div>
    </div>`;
  };

  const section = (title, count, rendered, hint = '') => {
    if (!count) return '';
    return `<section class="tag-sec">
      <h2>${title}<i>${fmtNum(count)}</i>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</h2>
      ${rendered}
    </section>`;
  };

  root.innerHTML =
    topbarHtml({ back: true, sub: '', actions: '' }) +
    `<main class="page">
       <div class="toolbar">
         <div style="min-width:0">
           <div class="crumb">标签</div>
           <div class="title-row"><h1 class="page-title">#${esc(name)}</h1></div>
         </div>
         <span class="spacer"></span>
         <span class="count">${metaBits.join(' · ')}</span>
       </div>
       <div data-tag-body></div>
     </main>`;

  bindTopbar(root);

  const body = root.querySelector('[data-tag-body]');
  if (!chars.length && !packs.length && !media.length) {
    body.innerHTML = `<div class="empty"><b>「${esc(name)}」下还没有内容</b>给图包或图片打上这个标签，它们就会出现在这里</div>`;
    return;
  }

  body.innerHTML =
    section('条目', counts.characters, `<div class="char-grid">${chars.map(charCard).join('')}</div>`) +
    section('图包', counts.packs, `<div class="pack-grid">${packs.map(packCard).join('')}</div>`) +
    section(
      '素材',
      counts.media,
      '<div class="masonry" data-masonry></div>',
      counts.media > media.length ? `只显示最近 ${fmtNum(media.length)} 个` : ''
    );

  body.querySelectorAll('img').forEach(fadeIn);

  const holder = body.querySelector('[data-masonry]');
  if (holder) {
    requestAnimationFrame(() => {
      renderMasonry(
        holder,
        media,
        (i) => go(`/i/${media[i].id}`),
        { spanWide: true }
      );
    });
  }
}
