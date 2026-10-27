import { esc } from '../util.js';
import { pushEsc } from '../esc.js';

/**
 * 自定义下拉。
 * 用原生 <datalist> 会多出一个浏览器画的三角，面板位置也不跟输入框对齐；
 * 这里自己画一个：面板宽度锁死跟输入框一致，选项 hover 黑底白字，面板不出滚动条。
 *
 * - `editable`：可以直接打字，输入的内容就是值（平台 / 出处这种「选择或输入」）
 * - `searchable`：可以打字筛选，但**值仍然只能从选项里选**（几千个条目的场景）
 *   面板一次最多画 `maxVisible` 项，剩下的提示「继续输入缩小范围」，避免一次插上千个按钮
 */
export function createDropdown({
  options = [],
  value = '',
  placeholder = '',
  editable = false,
  searchable = false,
  maxVisible = 60,
  allowEmpty = true,
  emptyLabel = '全部',
  name = '',
  onChange = null,
  className = '',
} = {}) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  // 不给「空」选项时默认选中第一个，避免弹窗一打开就是空白且提交被 required 卡住
  let current = value === '' && !allowEmpty && items.length ? items[0].value : value;
  let view = items.slice();
  let active = -1;
  let offEsc = null;
  const typeable = editable || searchable;

  const el = document.createElement('div');
  el.className = `dd${className ? ` ${className}` : ''}`;
  el.innerHTML = `
    <input class="dd-input" type="text" autocomplete="off" spellcheck="false" ${typeable ? '' : 'readonly'} />
    <span class="dd-arrow" aria-hidden="true"></span>
    <div class="dd-panel" hidden></div>`;
  const input = el.querySelector('.dd-input');
  const arrow = el.querySelector('.dd-arrow');
  const panel = el.querySelector('.dd-panel');
  if (name) input.name = name;
  input.placeholder = placeholder;
  // 表单提交要拿 value 而不是显示用的 label，从这里读
  input.dataset.ddEditable = editable ? '1' : '0';

  function labelOf(v) {
    if (String(v) === '' && allowEmpty) return emptyLabel;
    const hit = items.find((o) => String(o.value) === String(v));
    return hit ? hit.label : v || '';
  }
  input.value = labelOf(current);
  input.dataset.ddValue = current;

  function render() {
    const head = allowEmpty
      ? `<button type="button" class="dd-opt${current === '' ? ' is-on' : ''}" data-v="">${esc(emptyLabel)}</button>`
      : '';
    // searchable 时只画前 maxVisible 项：几千个条目一次插进 DOM 会明显卡顿
    const shown = searchable ? view.slice(0, maxVisible) : view;
    const body = shown.length
      ? shown
          .map(
            (o, i) =>
              `<button type="button" class="dd-opt${String(o.value) === String(current) ? ' is-on' : ''}${
                i === active ? ' is-active' : ''
              }" data-v="${esc(o.value)}">${esc(o.label)}</button>`
          )
          .join('') + (searchable && view.length > shown.length ? `<div class="dd-more">还有 ${view.length - shown.length} 项，继续输入缩小范围</div>` : '')
      : '<div class="dd-empty">没有匹配项</div>';
    panel.innerHTML = head + body;
  }

  function open() {
    if (!panel.hidden) return;
    // 没有可选项就干脆不弹：空面板会盖在弹窗底部按钮上
    if (!items.length && !allowEmpty) return;
    view = items.slice();
    active = -1;
    render();
    panel.hidden = false;
    el.classList.add('is-open');
    // 下面放不下就往上翻
    const box = el.getBoundingClientRect();
    el.classList.toggle('drop-up', window.innerHeight - box.bottom < 300 && box.top > 300);
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    offEsc = pushEsc(() => close(), () => el.isConnected && !panel.hidden, 'dd:' + (name || 'x'));
  }

  function close(keepInput = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    el.classList.remove('is-open', 'drop-up');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    if (offEsc) {
      offEsc();
      offEsc = null;
    }
    // searchable 只是筛选框：关掉时把输入框恢复成「当前选中项」，
    // 否则里面留着半截搜索词，看着像选中了别的东西
    if (searchable && !keepInput) {
      input.value = labelOf(current);
      input.dataset.ddValue = current;
      view = items.slice();
      active = -1;
    }
  }

  function pick(v) {
    current = v;
    input.value = labelOf(v);
    input.dataset.ddValue = v;
    close();
    if (typeof onChange === 'function') onChange(v, labelOf(v));
  }

  function onDoc(e) {
    if (!el.contains(e.target)) close();
  }

  function onKey(e) {
    // Esc 交给 esc 栈（面板开着时它就在最上层）
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (panel.hidden) {
        open();
        return;
      }
      // 键盘在「实际画出来的那几项」里循环，searchable 截断后不能按全部 view 算
      const n = searchable ? Math.min(view.length, maxVisible) : view.length;
      if (!n) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + n) % n;
      render();
    }
    if (e.key === 'Enter' && !panel.hidden) {
      e.preventDefault();
      const target = view[active] || view[0];
      if (target) pick(target.value);
    }
  }

  input.addEventListener('mousedown', (e) => {
    if (typeable) {
      open();
      return;
    }
    e.preventDefault();
    if (panel.hidden) open();
    else close();
  });

  arrow.addEventListener('click', (e) => {
    e.preventDefault();
    if (panel.hidden) open();
    else close();
    if (typeable) input.focus();
  });

  input.addEventListener('input', () => {
    if (!typeable) return;
    // 先开面板再过滤：open() 会把 view 重置成全部，顺序反了过滤结果会被冲掉
    if (panel.hidden) open();
    const q = input.value.trim().toLowerCase();
    view = q ? items.filter((o) => o.label.toLowerCase().includes(q)) : items.slice();
    active = -1;
    // 没有匹配项就收起面板（留着空面板会挡住弹窗按钮），但不动输入框里的字
    if (!view.length) {
      close(true);
      return;
    }
    render();
  });

  input.addEventListener('focus', () => {
    if (typeable) open();
  });

  panel.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.dd-opt');
    if (!b) return;
    e.preventDefault();
    pick(b.dataset.v);
  });

  return {
    el,
    input,
    getValue: () => (editable ? input.value : current),
    setValue: (v) => {
      current = v;
      input.value = labelOf(v);
      input.dataset.ddValue = v;
    },
    setOptions: (list) => {
      items.length = 0;
      for (const o of list) items.push(typeof o === 'string' ? { value: o, label: o } : o);
      render();
    },
    close,
  };
}
