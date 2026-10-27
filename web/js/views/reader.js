import { api } from '../api.js';
import { esc, toast } from '../util.js';
import { escDepth } from '../esc.js';

/**
 * TXT 正文阅读器。
 *
 * 只做 txt（按编码解码 + 正则分章 + 上下滚动），EPUB / PDF 交给系统程序打开 ——
 * 项目是零构建原生 ESM，为了一个阅读器塞进一整套解压 + OPF 解析不划算。
 *
 * 分章是按行正则，不是完整的书籍解析：中文网文的「第X章」、英文的 Chapter N、
 * 序章 / 楔子 / 番外 都能认出来；认不出就整本当一章，照样能读。
 */

/** 章节标题行：整行匹配，避免正文里提到「第三章」被切开 */
const CH_RE =
  /^[\s\u3000]*(?:第\s*[0-9０-９一二三四五六七八九十百千万零〇两]{1,12}\s*[章节回卷篇集][^\n]{0,40}|(?:Chapter|CHAPTER)\s+\d{1,4}[^\n]{0,40}|(?:序章|序言|楔子|引子|终章|尾声|后记|番外)[^\n]{0,30})$/;

/** txt 编码：BOM 优先，其次严格 UTF-8，再退回 GB18030（老网文多半是 GBK） */
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(u8.subarray(3));
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(u8.subarray(2));
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(u8.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(u8);
    } catch {
      return new TextDecoder('utf-8').decode(u8);
    }
  }
}

function splitChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    if (!cur.title && !body) return; // 纯空白块
    out.push({ title: cur.title, body });
  };
  for (const line of lines) {
    const t = line.trim();
    if (t && t.length <= 60 && CH_RE.test(t)) {
      flush();
      cur = { title: t, lines: [] };
    } else {
      if (!cur) cur = { title: '', lines: [] };
      cur.lines.push(line);
    }
  }
  flush();
  if (!out.length) out.push({ title: '', body: text.trim() });
  return out;
}

const posKey = (id) => `cl-read:${id}`;
const fontKey = 'cl-read:font';

function loadPos(id) {
  try {
    return JSON.parse(localStorage.getItem(posKey(id)) || 'null') || {};
  } catch {
    return {};
  }
}
function savePos(id, obj) {
  try {
    localStorage.setItem(posKey(id), JSON.stringify(obj));
  } catch {
    /* 隐私模式写不了就只保留本次会话的位置 */
  }
}

export async function ReaderView(root, mediaId) {
  const id = Number(mediaId);
  let item;
  try {
    item = await api.media(id);
  } catch (err) {
    root.innerHTML = `<main class="page"><div class="empty"><b>打不开这本书</b>${esc(
      err.message || '文件可能已经被删掉了'
    )}</div></main>`;
    return;
  }

  const title = String(item.fileName || '').replace(/\.[^.]+$/, '') || '未命名';
  const bookName = (item.character && item.character.name) || '';
  const back = () => {
    if (history.state && history.state.from) history.back();
    else {
      history.pushState({}, '', `/c/${item.character ? item.character.id : ''}`);
      window.dispatchEvent(new CustomEvent('app:route'));
    }
  };

  const fontSize = Math.min(28, Math.max(15, Number(localStorage.getItem(fontKey)) || 18));

  root.innerHTML = `
    <div class="reader">
      <header class="reader-bar">
        <button class="rb-btn" data-reader-back aria-label="返回">‹</button>
        <div class="rb-text">
          <div class="rb-name" data-rb-name>${esc(title)}</div>
          <div class="rb-meta" data-rb-meta></div>
        </div>
        <span class="spacer"></span>
        <button class="rb-btn" data-fs="-1" aria-label="字号变小">A−</button>
        <button class="rb-btn" data-fs="1" aria-label="字号变大">A+</button>
        <button class="rb-btn" data-toc>目录</button>
      </header>
      <main class="reader-paper" data-paper>
        <h1 class="reader-ch" data-ch></h1>
        <div class="reader-body" data-body></div>
        <div class="reader-nav">
          <button class="tb-btn" data-prev>上一章</button>
          <button class="tb-btn" data-next>下一章</button>
        </div>
      </main>
      <div class="reader-toc" data-tocpanel hidden>
        <div class="rt-head"><b>目录</b><span data-toc-n></span><button class="rb-btn" data-toc-close>✕</button></div>
        <div class="rt-list" data-toc-list></div>
      </div>
    </div>`;

  const paper = root.querySelector('[data-paper]');
  const bodyEl = root.querySelector('[data-body]');
  const chEl = root.querySelector('[data-ch]');
  const metaEl = root.querySelector('[data-rb-meta]');
  const tocPanel = root.querySelector('[data-tocpanel]');
  const tocList = root.querySelector('[data-toc-list]');

  let chapters = [];
  let idx = 0;

  const applyFont = () => {
    paper.style.setProperty('--reader-fs', `${fontSize}px`);
  };
  applyFont();

  const paintMeta = () => {
    const c = chapters[idx] || {};
    const label = chapters.length > 1 ? `${idx + 1} / ${chapters.length}` : '全文';
    metaEl.textContent = label;
    chEl.textContent = c.title || '';
    chEl.hidden = !c.title;
    root.querySelector('[data-prev]').disabled = idx <= 0;
    root.querySelector('[data-next]').disabled = idx >= chapters.length - 1;
    root.querySelectorAll('[data-toc-list] a').forEach((a) => {
      a.classList.toggle('on', Number(a.dataset.ch) === idx);
    });
    document.title = `${c.title || title} · 阅读`;
  };

  const renderChapter = (next, restore = 0) => {
    if (next < 0 || next >= chapters.length) return;
    idx = next;
    const c = chapters[idx];
    // 段落 = 连续空行切块；中文网文一行一段，直接用「一个换行一段」
    const paras = String(c.body || '')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    bodyEl.innerHTML = paras.map((p) => `<p>${esc(p)}</p>`).join('');
    paintMeta();
    savePos(id, { ch: idx, ratio: 0 });
    const target = restore > 0 ? restore * (document.body.scrollHeight - window.innerHeight) : 0;
    window.scrollTo(0, Math.max(0, target));
  };

  /** 目录只画一次；章节多的时候按需替换也没必要，几百个 <a> 很便宜 */
  const paintToc = () => {
    root.querySelector('[data-toc-n]').textContent = `${chapters.length} 章`;
    tocList.innerHTML = chapters
      .map(
        (c, i) =>
          `<a href="#" data-ch="${i}" class="${i === idx ? 'on' : ''}">
             <i>${i + 1}</i><span>${esc(c.title || `第 ${i + 1} 部分`)}</span>
           </a>`
      )
      .join('');
    tocList.querySelectorAll('a[data-ch]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        renderChapter(Number(a.dataset.ch));
        tocPanel.hidden = true;
      });
    });
  };

  // 先出壳，再读文件：几 MB 的 txt 解码要一点时间，别让人对着空白等
  bodyEl.innerHTML = '<p class="reader-hint">正在载入正文…</p>';
  try {
    const res = await fetch(api.raw(id), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    const buf = await res.arrayBuffer();
    const text = decodeText(buf);
    chapters = splitChapters(text);
    paintToc();
    const saved = loadPos(id);
    renderChapter(Math.min(Math.max(0, Number(saved.ch) || 0), chapters.length - 1), Number(saved.ratio) || 0);
  } catch (err) {
    bodyEl.innerHTML = '';
    toast(err.message || '正文读取失败');
    chEl.textContent = '正文读取失败';
  }

  root.querySelector('[data-reader-back]').addEventListener('click', back);
  root.querySelectorAll('[data-fs]').forEach((b) => {
    b.addEventListener('click', () => {
      const cur = parseFloat(paper.style.getPropertyValue('--reader-fs')) || 18;
      const next = Math.min(28, Math.max(15, cur + Number(b.dataset.fs)));
      paper.style.setProperty('--reader-fs', `${next}px`);
      try {
        localStorage.setItem(fontKey, String(next));
      } catch {
        /* ignore */
      }
    });
  });
  root.querySelector('[data-prev]').addEventListener('click', () => renderChapter(idx - 1));
  root.querySelector('[data-next]').addEventListener('click', () => renderChapter(idx + 1));
  root.querySelector('[data-toc]').addEventListener('click', () => {
    tocPanel.hidden = !tocPanel.hidden;
  });
  root.querySelector('[data-toc-close]').addEventListener('click', () => {
    tocPanel.hidden = true;
  });

  /** 滚出屏幕就失传：位置按整页算，切章时先存一次，刷新回来接着读 */
  let saveTimer = 0;
  const remember = () => {
    const h = document.body.scrollHeight - window.innerHeight;
    const ratio = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
    savePos(id, { ch: idx, ratio });
  };
  const onScroll = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(remember, 400);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pagehide', remember);

  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
    if (escDepth() > 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      renderChapter(idx - 1);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      renderChapter(idx + 1);
    }
  };
  document.addEventListener('keydown', onKey);

  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pagehide', remember);
  };
}
