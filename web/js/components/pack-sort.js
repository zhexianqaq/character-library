import { createDropdown } from './dropdown.js';

/** 图包常见的四种排序维度 */
export const PACK_SORT_KEYS = [
  { value: 'date', label: '时间' },
  { value: 'name', label: '名称' },
  { value: 'count', label: '素材数量' },
  { value: 'size', label: '占用空间' },
];

/**
 * 时间键 = 「月份（或创建年月）」+「完整创建时间」。
 * 只比到月份的话，同一个月建的十几个图包全等 → 升降序看不出变化，
 * 用户点了箭头会以为坏了；带上创建时间才有真实先后。
 */
const timeOf = (p) => {
  const created = String(p.createdAt || '');
  const month = String(p.month || created.slice(0, 7));
  return `${month}#${created}`;
};
const nameOf = (p) => String(p.title || '');

/**
 * 排图包：返回新数组，不改原数组。
 *
 * 主键相同时**始终按名称升序**（次级排序不跟着倒序翻），
 * 这样「按时间倒序」里同月的几个包也稳定可预期，不会每次渲染顺序乱跳。
 */
export function sortPacks(list, key = 'date', desc = true) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const primary = (a, b) => {
    if (key === 'name') return nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN', { numeric: true });
    if (key === 'count') return (a.mediaCount || 0) - (b.mediaCount || 0);
    if (key === 'size') return (a.bytes || 0) - (b.bytes || 0);
    return timeOf(a).localeCompare(timeOf(b)) || 0;
  };
  arr.sort((a, b) => {
    const r = primary(a, b) * (desc ? -1 : 1);
    return r !== 0 ? r : nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN', { numeric: true });
  });
  return arr;
}

/**
 * 图包排序控件：一个维度下拉 + 一个升降序按钮。
 *
 * @param {object} opts
 * @param {string} opts.key    初始维度（date / name / count / size）
 * @param {boolean} opts.desc   初始是否倒序（默认 true：新的 / 大的在前）
 * @param {(key:string, desc:boolean)=>void} opts.onChange
 */
export function createPackSort({ key = 'date', desc = true, onChange = null } = {}) {
  let curKey = key;
  let curDesc = desc !== false;

  const el = document.createElement('span');
  el.className = 'pack-sort';

  const dirBtn = document.createElement('button');
  dirBtn.type = 'button';
  dirBtn.className = 'tb-btn sort-dir';
  const paintDir = () => {
    dirBtn.textContent = curDesc ? '↓' : '↑';
    dirBtn.title = curDesc ? '当前：倒序，点一下改成顺序' : '当前：顺序，点一下改成倒序';
    dirBtn.setAttribute('aria-label', curDesc ? '倒序' : '顺序');
  };

  const fire = () => {
    if (typeof onChange === 'function') onChange(curKey, curDesc);
  };

  const dd = createDropdown({
    options: PACK_SORT_KEYS,
    value: curKey,
    allowEmpty: false,
    className: 'sort-dd',
    onChange: (v) => {
      curKey = v;
      fire();
    },
  });

  dirBtn.addEventListener('click', () => {
    curDesc = !curDesc;
    paintDir();
    fire();
  });
  paintDir();

  el.append(dd.el, dirBtn);
  return {
    el,
    get key() {
      return curKey;
    },
    get desc() {
      return curDesc;
    },
  };
}
