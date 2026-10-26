import { esc } from '../util.js';
import { createDropdown } from './dropdown.js';

/**
 * 通用表单弹窗。
 * fields: [{ name, label, type, value, placeholder, required, hint, options, half, rows }]
 *   type: text | month | textarea | select | url
 *   options: string[] | [{ value, label }]（type=select 时用）
 *   half: true 时相邻的 half 字段会排成一行两列
 * onMount(bodyEl, root): 插入 DOM 后回调，可做联动
 * transform(values, bodyEl): 提交前改写返回值
 * 返回 Promise<values|null>
 */
export function openModal({
  title,
  fields = [],
  submitText = '确定',
  danger = false,
  description = '',
  onMount,
  transform,
}) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal-mask';

    // datalist 字段改成自定义下拉：原生 datalist 会多画一个三角，面板也不跟输入框对齐
    const combos = [];

    const fieldHtml = (f) => {
      let control;
      if (f.type === 'textarea') {
        control = `<textarea name="${esc(f.name)}" rows="${f.rows || 4}" placeholder="${esc(
          f.placeholder || ''
        )}">${esc(f.value || '')}</textarea>`;
      } else if (f.type === 'datalist') {
        const idx = combos.push({
          name: f.name,
          options: f.options || [],
          value: f.value || '',
          placeholder: f.placeholder || '',
          editable: true,
          allowEmpty: false,
        }) - 1;
        control = `<div class="dd-slot" data-dd-slot="${idx}"></div>`;
      } else if (f.type === 'select') {
        const opts = (f.options || []).map((o) =>
          typeof o === 'string' ? { value: o, label: o } : o
        );
        // 原生 select 展开是系统蓝条，样式跟站内对不上，统一走自定义下拉
        const idx = combos.push({
          name: f.name,
          options: opts,
          value: f.value || '',
          placeholder: f.placeholder || '',
          editable: false,
          allowEmpty: !!f.placeholder,
          emptyLabel: f.placeholder || '全部',
        }) - 1;
        control = `<div class="dd-slot" data-dd-slot="${idx}"></div>`;
      } else {
        control = `<input name="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(
          f.value || ''
        )}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} />`;
      }
      return `<label class="field ${f.half ? 'field-half' : ''}">
        <span>${esc(f.label)}${f.required ? ' <i>*</i>' : ''}</span>
        ${control}
        ${f.hint ? `<em>${esc(f.hint)}</em>` : ''}
      </label>`;
    };

    // 相邻的 half 字段并成一行两列，其余整行
    const parts = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      parts.push(`<div class="field-row">${buf.join('')}</div>`);
      buf = [];
    };
    for (const f of fields) {
      if (f.half) {
        buf.push(fieldHtml(f));
        if (buf.length === 2) flush();
      } else {
        flush();
        parts.push(fieldHtml(f));
      }
    }
    flush();

    root.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${description ? `<p class="modal-desc">${esc(description)}</p>` : ''}
        <div class="modal-body">${parts.join('')}</div>
        <div class="modal-actions">
          <button class="tb-btn" data-cancel>取消</button>
          <button class="tb-btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(submitText)}</button>
        </div>
      </div>`;

    document.body.appendChild(root);

    for (const [idx, cfg] of combos.entries()) {
      const slot = root.querySelector(`[data-dd-slot="${idx}"]`);
      if (!slot) continue;
      const dd = createDropdown({
        name: cfg.name,
        options: cfg.options,
        value: cfg.value,
        placeholder: cfg.placeholder,
        editable: cfg.editable !== false,
        allowEmpty: cfg.allowEmpty !== false,
        emptyLabel: cfg.emptyLabel || '全部',
        className: 'dd-field',
      });
      slot.replaceWith(dd.el);
    }

    const body = root.querySelector('.modal-body');
    if (typeof onMount === 'function') {
      try {
        onMount(body, root);
      } catch (err) {
        console.error('[modal] onMount 失败', err);
      }
    }

    const first = root.querySelector('input, select, textarea');
    if (first) {
      first.focus();
      if (first.select && first.tagName === 'INPUT') first.select();
    }

    const close = (val) => {
      root.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    const submit = () => {
      const values = {};
      for (const f of fields) {
        const el = root.querySelector(`[name="${f.name}"]`);
        if (!el) {
          values[f.name] = '';
        } else if (el.dataset && el.dataset.ddValue !== undefined && el.dataset.ddEditable !== '1') {
          // 自定义下拉：提交 value 而不是显示用的 label
          values[f.name] = String(el.dataset.ddValue);
        } else {
          values[f.name] = String(el.value).trim();
        }
        if (f.required && !values[f.name]) {
          el.focus();
          el.classList.add('invalid');
          setTimeout(() => el.classList.remove('invalid'), 1200);
          return;
        }
      }
      close(typeof transform === 'function' ? transform(values, body) : values);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      // 单行输入框里按 Enter 直接提交，文本框里保留换行
      if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.tagName === 'INPUT') {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    };

    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-ok]').addEventListener('click', submit);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close(null);
    });
    document.addEventListener('keydown', onKey);
  });
}

export function confirmDialog(title, description, submitText = '确定删除') {
  return openModal({ title, description, submitText, danger: true }).then((v) => !!v);
}
