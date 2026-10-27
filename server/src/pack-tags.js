/**
 * 图包名 → 自动标签。
 *
 * 用户的命名约定是「角色-服装」：`卡芙卡-泳装` 要拆成「卡芙卡」「泳装」两条标签，
 * 角色页靠「标签正好等于条目名」才能把包挂过去。整串当一个标签永远匹配不上，
 * 于是出现「加了标签却没进 cosplay」。
 *
 * 但有三种情况必须原样保留（宁可整串一个标签，也不要拆错）：
 *   · 纯日期：`2026-10`、`2026-10-27` —— 按月份自动建的包就叫这个
 *   · 拆出来有纯数字段：`花兮-20240101`、`cos-01` 这类是编号，不是「角色-服装」
 *   · 拆出来少于 2 段或多于 4 段：不像命名约定，更像标题本身
 */

const DATE_LIKE = /^\d{4}[-./]\d{1,2}([-./]\d{1,2})?$/;

export function splitTitleTags(title) {
  const t = String(title || '').trim();
  if (!t) return [];
  if (DATE_LIKE.test(t)) return [t];

  const parts = [...new Set(t
    .split(/[-－—]/)
    .map((s) => s.trim())
    .filter(Boolean))];

  if (parts.length < 2 || parts.length > 4) return [t];
  if (parts.some((p) => p.length < 2 || /^\d+$/.test(p))) return [t];
  return parts;
}
