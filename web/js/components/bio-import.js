import { openModal } from './modal.js';
import { api } from '../api.js';
import { esc, toast } from '../util.js';
import { parseBioText } from '../bio-import.js';

/**
 * 「批量导入别名 / 简介」弹窗。
 *
 * 交互：粘贴文本 → 防抖 350ms 自动解析 → 调一次 dryRun 预览匹配结果（哪个条目能对上、
 * 会不会覆盖已有简介）→ 点「导入」才真正写库。
 *
 * 返回：写入结果（含 skipped）；用户取消或出错返回 null。写库失败不关弹窗也无意义，
 * 因为真正写入是在弹窗关闭之后，所以出错就用 toast 报出来。
 */
export async function openBioImport({ shelfId, shelfName }) {
  const state = { items: [], preview: null, overwrite: false, mode: 'merge', seq: 0, timer: 0 };
  let write = null;

  const v = await openModal({
    title: '批量导入简介',
    description: '把 AI 生成的内容粘进来：一行条目名，下面「别名：」「简介：」；多条之间用 --- 分隔也行。别名里的「（英文）」「（日文）」会自动去掉。只写这两个字段，名字、分类、素材都不动。',
    fields: [],
    className: 'bio-modal',
    submitText: '导入',
    onMount: (body, root) => {
      body.innerHTML = `
        <div class="bio-import">
          <textarea class="bi-input" data-bi-input rows="9" spellcheck="false" autocomplete="off"
            placeholder="赞妮&#10;别名：焰光的夜行者、Zani（英文）、ザンニー（日文）&#10;简介：「赞妮」是《鸣潮》中埃弗拉德银行防卫科雇员……&#10;---&#10;菲比&#10;别名：见习教士菲比、Phoebe&#10;简介：「菲比」是《鸣潮》中隐海修会的教士……"></textarea>
          <div class="bi-opts">
            <label class="bi-check"><input type="checkbox" data-bi-overwrite /> 覆盖已有简介</label>
            <span class="bi-seg" data-bi-mode>
              <button type="button" data-mode="merge" class="on">别名合并</button>
              <button type="button" data-mode="replace">别名替换</button>
            </span>
          </div>
          <div class="bi-summary" data-bi-summary>粘贴后会自动识别条目</div>
          <div class="bi-list" data-bi-list></div>
        </div>`;

      const input = body.querySelector('[data-bi-input]');
      const listEl = body.querySelector('[data-bi-list]');
      const sumEl = body.querySelector('[data-bi-summary]');
      const ow = body.querySelector('[data-bi-overwrite]');
      const seg = body.querySelector('[data-bi-mode]');
      const okBtn = root.querySelector('[data-ok]');
      okBtn.disabled = true;

      const renderPreview = () => {
        const { items } = parseBioText(input.value);
        state.items = items;
        if (!items.length) {
          state.preview = null;
          listEl.innerHTML = '';
          sumEl.textContent = input.value.trim() ? '没有识别到条目 —— 检查是不是缺了条目名那一行' : '粘贴后会自动识别条目';
          sumEl.classList.toggle('is-warn', !!input.value.trim());
          okBtn.disabled = true;
          return;
        }
        sumEl.classList.remove('is-warn');
        sumEl.textContent = `已识别 ${items.length} 条，正在核对库里有没有同名条目…`;
        const my = ++state.seq;
        api
          .bulkBio({ shelfId, items, overwriteIntro: state.overwrite, aliasMode: state.mode, dryRun: true })
          .then((res) => {
            if (my !== state.seq) return;
            state.preview = res;
            const miss = (res.skipped || []).filter((s) => s.reason === '未找到同名条目').length;
            const blocked = (res.skipped || []).length - miss;
            sumEl.textContent = [
              `识别 ${items.length} 条`,
              `将写入 ${res.matched} 条`,
              miss ? `未找到 ${miss} 条` : '',
              blocked ? `跳过 ${blocked} 条` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            okBtn.disabled = res.matched === 0;
            renderList(res);
          })
          .catch((err) => {
            if (my !== state.seq) return;
            sumEl.textContent = err.message || '核对失败';
            sumEl.classList.add('is-warn');
          });
      };

      const renderList = (res) => {
        const byName = new Map((res.items || []).map((x) => [x.name, x]));
        const skipByName = new Map((res.skipped || []).map((x) => [x.name, x]));
        listEl.innerHTML = state.items
          .map((it) => {
            const hit = byName.get(it.name);
            const miss = skipByName.get(it.name);
            const aliasBit = it.aliases.length ? `+${it.aliases.length} 别名` : '无别名';
            const introBit = it.intro ? `简介 ${it.intro.length} 字` : '无简介';
            let flag = '将写入';
            if (miss) flag = miss.reason;
            else if (hit && hit.introChanged) flag = hit.hasIntro ? '覆盖已有简介' : '写入简介';
            else if (hit) flag = '保留原简介';
            return `<div class="bi-row${miss ? ' is-miss' : ''}">
              <span class="bi-name">${esc(it.name)}</span>
              <span class="bi-meta">${aliasBit} · ${introBit}</span>
              <span class="bi-flag">${esc(flag)}</span>
            </div>`;
          })
          .join('');
      };

      const schedule = () => {
        clearTimeout(state.timer);
        state.timer = setTimeout(renderPreview, 350);
      };

      input.addEventListener('input', schedule);
      ow.addEventListener('change', () => {
        state.overwrite = ow.checked;
        renderPreview();
      });
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mode]');
        if (!b) return;
        state.mode = b.dataset.mode === 'replace' ? 'replace' : 'merge';
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        renderPreview();
      });

      // 直接粘贴就粘完：先跑一次（textarea 若是初始为空，仍会显示提示）
      input.focus();

      // 供 modal 的 transform 取用
      write = () => {
        const { items } = parseBioText(input.value);
        return { items, overwriteIntro: state.overwrite, aliasMode: state.mode };
      };
    },
    transform: () => (write ? write() : { items: [], overwriteIntro: false, aliasMode: 'merge' }),
  });

  if (!v || !Array.isArray(v.items) || !v.items.length) return null;

  try {
    const res = await api.bulkBio({
      shelfId,
      items: v.items,
      overwriteIntro: v.overwriteIntro,
      aliasMode: v.aliasMode,
      dryRun: false,
    });
    return res;
  } catch (err) {
    toast(err.message || '导入失败');
    return null;
  }
}
