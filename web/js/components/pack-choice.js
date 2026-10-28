/**
 * 「目标图包」下拉：列出已有图包，同时允许直接输入一个新名称。
 *
 * 以前是「在下拉里选『＋ 新建图包…』→ 再弹一个窗填名称」，两步才能新建；
 * 现在输入框本身就是可编辑的，打一个不存在的名字就等于新建。
 *
 * 选项 label 只放名称、不放「（12 项）」：可编辑下拉提交时，
 * 反查已有图包只能靠文本，带数量后缀会让「尤诺」和「尤诺（0）」对不上。
 */

/** 下拉里显示的文本：角色集带小库前缀（官图 / cos / 同人） */
export function packLabel(p) {
  return `${p && p.category ? `${p.category} / ` : ''}${(p && p.title) || ''}`;
}

export function packOptions(packs) {
  return (packs || []).map((p) => ({ value: String(p.id), label: packLabel(p) }));
}

/** 输入框文本 → 已有图包；不是已有名字返回 null，交给调用方去新建 */
export function matchPack(packs, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const list = packs || [];
  return (
    list.find((p) => packLabel(p) === t) ||
    list.find((p) => String(p.title || '') === t) ||
    null
  );
}
