/**
 * 条目重名比较用的名字。
 *
 * 只在同一个库（shelves.id，界面上的「人物集 / 角色集 / …」）里比较。
 * 别名不参与。不同的库可以同名。
 *
 * 规则（显示名保持用户输入的大小写和全角，比较用另一条 key）：
 *   1. 首尾空白去掉，中间连续空白并成一个空格（比较和存库的显示名都做）
 *   2. key 再做 NFKC：全角英数、全角空格折成半角（「Ａ」和「A」算同一个）
 *   3. key 再 toLowerCase：英文大小写不敏感（「Aqua」和「aqua」算同一个）
 * 中文没有大小写，NFKC 只折兼容字形，不把两个不同的汉字并成一个。
 */

export function storedEntryName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export function entryNameKey(raw) {
  const shown = storedEntryName(raw);
  if (!shown) return '';
  return shown.normalize('NFKC').toLowerCase();
}
