import { esc } from '../util.js';

/**
 * 别名编辑器：**一个单行输入框 + 回车入列**，替代以前「一个大 textarea 一行一个」。
 *
 * 为什么不再用 textarea：别名一般就两三条，给四行的框既占地方，又把「换行 / 顿号 /
 * 逗号」这些格式要求丢给用户；做成 chip 列表后，输一个回车一个，点 chip 就删。
 *
 * 用法（配合 openModal 的 onMount / transform）：
 *   let ed = null;
 *   const v = await openModal({
 *     fields: [],
 *     onMount: (body) => { ed = mountAliasEditor(body, cur); },
 *     transform: () => ({ aliases: ed ? ed.read() : cur }),
 *   });
 *
 * `read()` 会把输入框里**还没回车**的内容一起并入 —— 否则「输了没回车就点保存」会丢东西。
 */
export function mountAliasEditor(host, values, { max = 20, maxLen = 60, hint = '' } = {}) {
  const picked = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const v = String(raw == null ? '' : raw).trim().slice(0, maxLen);
    if (v && !picked.includes(v) && picked.length < max) picked.push(v);
  }

  host.innerHTML = `
    <div class="alias-editor">
      <div class="ae-chips" data-chips></div>
      <div class="ae-row">
        <input class="ae-input" data-ae-input type="text" autocomplete="off" spellcheck="false"
               maxlength="${maxLen}" placeholder="输入一个别名，回车添加" />
        <button type="button" class="tb-btn ae-add" data-ae-add>添加</button>
      </div>
      <p class="ae-hint">${esc(hint || '简称 / 原名 / 日文名 / 英文名都行。')}<span data-ae-count></span></p>
    </div>`;

  const chipsEl = host.querySelector('[data-chips]');
  const input = host.querySelector('[data-ae-input]');
  const countEl = host.querySelector('[data-ae-count]');
  const addBtn = host.querySelector('[data-ae-add]');

  function paint() {
    chipsEl.innerHTML = picked.length
      ? picked
          .map(
            (a, i) =>
              `<button type="button" class="ae-chip" data-i="${i}" title="点一下删除「${esc(a)}」">${esc(
                a
              )}<span aria-hidden="true">×</span></button>`
          )
          .join('')
      : '<span class="ae-empty">还没有别名</span>';
    const full = picked.length >= max;
    countEl.textContent = full ? `（最多 ${max} 个，已满）` : '';
    addBtn.disabled = full;
    input.disabled = full;
  }

  /** 把一段文本拆成别名并入列；返回新增条数。粘贴多个（顿号 / 逗号 / 换行）也能一次进去 */
  function commit(raw) {
    const parts = String(raw == null ? '' : raw)
      .split(/[,，、\n\r\t]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    let added = 0;
    for (const p of parts) {
      if (picked.length >= max) break;
      const v = p.slice(0, maxLen);
      if (!v || picked.includes(v)) continue;
      picked.push(v);
      added += 1;
    }
    return added;
  }

  function addFromInput() {
    if (!input.value.trim()) return false;
    const n = commit(input.value);
    input.value = '';
    paint();
    return n > 0;
  }

  input.addEventListener('keydown', (e) => {
    // 中文输入法选词时的回车 / 上下键不算提交
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      // 有内容：抢下弹窗的 Enter（它默认是保存），先入列
      // 没内容：放行 —— 此时回车 = 保存，符合「输完直接回车」的直觉
      if (!input.value.trim()) return;
      e.preventDefault();
      e.stopPropagation();
      addFromInput();
      return;
    }
    // 输入框空的时候退格删掉最后一个 chip，和常见的标签输入一致
    if (e.key === 'Backspace' && !input.value && picked.length) {
      e.preventDefault();
      picked.pop();
      paint();
    }
  });

  addBtn.addEventListener('click', () => {
    addFromInput();
    input.focus();
  });

  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.ae-chip');
    if (!chip) return;
    picked.splice(Number(chip.dataset.i), 1);
    paint();
    input.focus();
  });

  paint();

  return {
    read() {
      // 还没回车的内容也算（不然输完直接点保存就丢了）
      if (input.value.trim()) {
        commit(input.value);
        input.value = '';
        paint();
      }
      return picked.slice(0, max);
    },
    focus() {
      input.focus();
    },
  };
}
