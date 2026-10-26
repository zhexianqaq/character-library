import { api } from '../api.js';
import { esc, toast } from '../util.js';

/** 归一化：全角转半角、小写、去掉空格和分隔符 */
function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·.,_\-\/|]+/g, '');
}

/** 相似度 0~1：完全相同 1，包含关系 0.9，其余用二元组 Dice 系数 */
export function tagSimilarity(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.9;
  if (A.length < 2 || B.length < 2) return 0;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return (2 * hit) / (ga.size + gb.size);
}

const SIMILAR = 0.5;

/**
 * 标签选择弹窗：上方输入框，下方已有标签列表（点击选中/取消），底部确认。
 * 输入时会做查重与相似校验，避免加出「水淼 / 水淼cos」这种重复项。
 * 返回 Promise<string[]|null>（null = 取消）
 */
export async function openTagPicker({ title = '编辑标签', selected = [] } = {}) {
  let pool = [];
  try {
    pool = (await api.tags()).items || [];
  } catch {
    pool = [];
  }

  const chosen = new Set(selected.map((t) => String(t)));
  const extra = [];  // 本次新输入、池子里还没有的标签

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal-mask';
    root.innerHTML = `
      <div class="modal tag-modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="tag-input-row">
          <input class="tag-input" type="text" placeholder="输入新标签，回车添加" autocomplete="off" maxlength="40" />
          <button class="tb-btn" data-add>添加</button>
        </div>
        <div class="tag-hint" data-hint></div>
        <div class="tag-section">已有标签<i data-total></i></div>
        <div class="tag-pool" data-pool></div>
        <div class="modal-actions">
          <button class="tb-btn" data-cancel>取消</button>
          <button class="tb-btn primary" data-ok>确认</button>
        </div>
      </div>`;

    document.body.appendChild(root);

    const input = root.querySelector('.tag-input');
    const hintEl = root.querySelector('[data-hint]');
    const poolEl = root.querySelector('[data-pool]');
    const totalEl = root.querySelector('[data-total]');

    const all = () => [
      ...pool.map((p) => p.name),
      ...extra.filter((n) => !pool.some((p) => p.name === n)),
    ];

    const renderPool = () => {
      const names = all();
      totalEl.textContent = names.length ? `（${names.length}）` : '';
      if (!names.length) {
        poolEl.innerHTML = '<span class="tag-empty">还没有任何标签，在上面输入第一个吧</span>';
        return;
      }
      const counts = new Map(pool.map((p) => [p.name, p.count]));
      poolEl.innerHTML = names
        .map(
          (n) => `<button class="tag-pill${chosen.has(n) ? ' on' : ''}" data-tag="${esc(n)}">
            ${esc(n)}${counts.get(n) ? `<i>${counts.get(n)}</i>` : ''}
          </button>`
        )
        .join('');
      poolEl.querySelectorAll('[data-tag]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const n = btn.dataset.tag;
          if (chosen.has(n)) chosen.delete(n);
          else chosen.add(n);
          renderPool();
          setHint('');
        });
      });
    };

    const setHint = (html) => {
      hintEl.innerHTML = html;
      hintEl.classList.toggle('show', Boolean(html));
    };

    /** 查重 + 相似校验；返回 true 表示已处理（不需要再添加） */
    const tryAdd = (force = false) => {
      const raw = input.value.trim();
      if (!raw) {
        input.focus();
        return;
      }
      const name = raw.slice(0, 40);

      // 1) 完全相同（归一化后）：直接选中，不再新增
      const same = all().find((n) => norm(n) === norm(name));
      if (same) {
        chosen.add(same);
        input.value = '';
        renderPool();
        setHint(`已经有「${esc(same)}」了，已帮你选中`);
        return;
      }

      // 2) 相似：默认拦下，给一个「仍然添加」的出口
      if (!force) {
        const sims = all()
          .map((n) => ({ n, s: tagSimilarity(n, name) }))
          .filter((x) => x.s >= SIMILAR)
          .sort((a, b) => b.s - a.s)
          .slice(0, 3);
        if (sims.length) {
          setHint(
            `和已有标签${sims.map((x) => `「${esc(x.n)}」`).join('')}很像，避免重复？` +
              `<a data-force>仍然添加</a>`
          );
          hintEl.querySelector('[data-force]').addEventListener('click', () => tryAdd(true));
          return;
        }
      }

      // 3) 真正新增
      extra.push(name);
      chosen.add(name);
      input.value = '';
      renderPool();
      setHint('');
      input.focus();
    };

    const close = (val) => {
      root.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryAdd();
      }
    });
    input.addEventListener('input', () => setHint(''));

    root.querySelector('[data-add]').addEventListener('click', () => tryAdd());
    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-ok]').addEventListener('click', () => {
      // 输入框里还有没按回车的内容，顺手加上
      if (input.value.trim()) tryAdd();
      if (input.value.trim()) return;  // 被相似校验拦住了，先让用户确认
      close([...chosen]);
    });
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close(null);
    });
    document.addEventListener('keydown', onKey);

    renderPool();
    // 已有标签里跟当前输入无关，先给个总数提示
    setHint('');
    input.focus();
  });
}

/** 便捷入口：打开弹窗并把结果写回角色 */
export async function editCharacterTags(char, apiUpdate) {
  const next = await openTagPicker({ title: '编辑标签', selected: char.tags || [] });
  if (!next) return null;
  await apiUpdate({ tags: next });
  toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
  return next;
}
