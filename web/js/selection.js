/**
 * 多选点击规则（Shift 连选 / Ctrl 追加取消）。
 *
 * - 普通点击、Ctrl(⌘) 点击：切换这一项（和以前一致）
 * - Shift 点击：从锚点到这一项整段选中；不带 Ctrl 会先清空，带 Ctrl 就是叠加
 * - 没有锚点（刚进选取模式）时 Shift 点击退化成普通点击
 *
 * 只改 Set，不碰 DOM —— 勾选态由调用方统一重画，避免漏掉范围里的瓦片。
 *
 * @param {Set<number>} picked 选择集（原地修改）
 * @param {number[]} ordered 当前**显示顺序**的 id 列表
 * @returns {{anchorId: number|null, bulk: boolean}} bulk=true 表示整批勾选态变了
 */
export function applyPickClick({ picked, ordered, id, ev, anchorId = null }) {
  const shift = !!(ev && ev.shiftKey);
  const multi = !!(ev && (ev.ctrlKey || ev.metaKey));

  if (shift && anchorId !== null && anchorId !== undefined) {
    const a = ordered.indexOf(anchorId);
    const b = ordered.indexOf(id);
    if (a >= 0 && b >= 0) {
      if (!multi) picked.clear();
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      for (let i = from; i <= to; i += 1) picked.add(ordered[i]);
      // 锚点不动：连续 Shift 是在同一段基础上扩，符合文件管理器的习惯
      return { anchorId, bulk: true };
    }
  }

  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  return { anchorId: id, bulk: false };
}
