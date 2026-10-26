/**
 * 全局 Esc 派发。
 *
 * 页面上可能同时叠着好几层：页面 → 弹窗 → 下拉面板 / 右键菜单 → 灯箱。
 * 如果每层都自己监听 keydown，一次 Esc 会把底下几层一起关掉（甚至把详情页退出去）。
 *
 * 这里维护一个栈：谁打开谁入栈，Esc 只交给**最上面那一层**，并且吃掉事件，
 * 页面级的 Esc（比如详情页返回）不会跟着触发。
 */

const stack = [];
let seq = 0;

/**
 * 注册一层 Esc 处理，后注册的算上层。
 * @param {(e: KeyboardEvent) => void} fn
 * @param {() => boolean} [alive] 可选存活判断：返回 false 时这层会被自动丢弃，
 *   防止「弹窗开着时整页被替换 / 组件自己移除 DOM 却没注销」在栈里留死层
 * @returns {() => void} 注销函数（关闭时务必调用）
 */
export function pushEsc(fn, alive = null) {
  const entry = { id: (seq += 1), fn, alive };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** 当前有几层弹层，页面级 Esc 用它决定要不要让路 */
export function escDepth() {
  while (stack.length && stack[stack.length - 1].alive && !stack[stack.length - 1].alive()) {
    stack.pop();
  }
  return stack.length;
}

/** 只给测试 / 调试用 */
export function escStackSize() {
  return stack.length;
}

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return;
    // 顺手清掉已经不存在的层（DOM 没了的弹窗不该再吃 Esc）
    while (stack.length && stack[stack.length - 1].alive && !stack[stack.length - 1].alive()) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (!top) return; // 没有弹层：交给页面自己处理（内联编辑、退出选取…）
    e.preventDefault();
    // 用 immediate：事件如果是直接派发在 document 上的，stopPropagation 挡不住同一节点上的其它监听
    e.stopImmediatePropagation();
    try {
      top.fn(e);
    } catch (err) {
      console.error('[esc] handler 失败', err);
    }
  },
  true
);
