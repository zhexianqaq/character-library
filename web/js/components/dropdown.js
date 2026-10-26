import { esc } from '../util.js';
import { pushEsc } from '../esc.js';

/**
 * 自定义下拉。
 * 用原生 <datalist> 会多出一个浏览器画的三角，面板位置也不跟输入框对齐；
 * 这里自己画一个：面板宽度锁死跟输入框一致，选项 hover 黑底白字，面板不出滚动条。
 *
 * editable = true 时可以直接在输入框里打字过滤（平台 / 出处这种「选择或输入」的场景）。
 */
export function createDropdown({
  options = [],
  value = '',
  placeholder = '',
  editable = false,
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

  const el = document.createElement('div');
  el.className = `dd${className ? ` ${className}` : ''}`;
  el.innerHTML = `
    <input class="dd-input" type="text" autocomplete="off" spellcheck="false" ${editable ? '' : 'readonly'} />
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
    const body = view.length
      ? view
          .map(
            (o, i) =>
              `<button type="button" class="dd-opt${String(o.value) === String(current) ? ' is-on' : ''}${
                i === active ? ' is-active' : ''
              }" data-v="${esc(o.value)}">${esc(o.label)}</button>`
          )
          .join('')
      : '<div class="dd-empty">没有匹配项</div>';
    panel.innerHTML = head + body;
  }

  function open() {
    if (!panel.hidden) return;
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
    offEsc = pushEsc(() => close(), () => el.isConnected && !panel.hidden);
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    el.classList.remove('is-open', 'drop-up');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    if (offEsc) {
      offEsc();
      offEsc = null;
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
      if (!view.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + view.length) % view.length;
      render();
    }
    if (e.key === 'Enter' && !panel.hidden) {
      e.preventDefault();
      const target = view[active] || view[0];
      if (target) pick(target.value);
    }
  }

  input.addEventListener('mousedown', (e) => {
    if (editable) {
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
    if (editable) input.focus();
  });

  input.addEventListener('input', () => {
    if (!editable) return;
    const q = input.value.trim().toLowerCase();
    view = q ? items.filter((o) => o.label.toLowerCase().includes(q)) : items.slice();
    active = -1;
    if (panel.hidden) open();
    else render();
  });

  input.addEventListener('focus', () => {
    if (editable) open();
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
