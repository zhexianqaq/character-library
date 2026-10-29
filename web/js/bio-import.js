/**
 * 解析 AI 生成的条目资料，转成 `{ name, aliases[], intro }`。
 *
 * 约定格式（条目名单独一行，下面两行是字段；中英文冒号都认）：
 *
 *   赞妮
 *   别名：焰光的夜行者、Zani、ザンニー
 *   简介：「赞妮」是《鸣潮》中来自黎那汐塔的……
 *   西格莉卡
 *   别名：未来的秘日六席、小橘子、Sigrika
 *   简介：「西格莉卡」是《鸣潮》中……
 *
 * 识别条目名的方式是**看下一行**：如果下一行是「别名：」或「简介：」，这一行就是名字。
 * 比「短行算名字」稳得多 —— 简介里也会有短句。
 *
 * 额外容错：
 *   - 条目之间用 `---` / `===` / `***` 分隔时，分隔线直接忽略（不然会被当成简介的续行）
 *   - 别名带语言标注（`Zani（英文）`、`シグリカ(日文)`）时，标注去掉只留别名本身；
 *     只认「语言/名字」这类纯标注，`菲比（Phoebe）` 这种括号里是真别名的保留原样
 *   - 行首序号 / 项目符号、半角冒号、一行内多个别名（顿号 / 逗号 / 分号）都能吃
 */

const ALIAS_RE = /^(?:别名|别称|别名列表|aliases?|alias)\s*[:：]\s*(.*)$/i;
const INTRO_RE = /^(?:简介|介绍|描述|intro(?:duction)?|description|bio)\s*[:：]\s*(.*)$/i;
/** 行首的序号 / 项目符号（"1. "、"2、"、"- "、"• "），AI 常带 */
const BULLET_RE = /^(?:[-*•·]|\d{1,3}[.、)）])\s*/;

/** 单独一行、三个以上重复符号 —— 条目分隔线，跳过 */
const SEPARATOR_RE = /^[-*_=~—]{3,}$/;

/**
 * 别名结尾的语言标注：`Zani（英文）` / `シグリカ(日文)`。
 * 只在「括号里是语言或名字分类」时才去掉 —— 换成 `菲比（Phoebe）` 这种括号里是
 * 真别名的，标注不匹配，整串保留。
 */
const ALIAS_NOTE_RE =
  /[（(]\s*(?:英文|日文|中文|韩文|罗马音?|拼音|繁体|简体|简称|全称|全名|本名|原名|昵称|别称|译名|艺名|英文名|日文名|中文名|日文汉字|声优|CV|配音|中配|日配|罗马字)\s*[）)]\s*$/;

function fieldOf(line) {
  let m = ALIAS_RE.exec(line);
  if (m) return { key: 'aliases', value: m[1] };
  m = INTRO_RE.exec(line);
  if (m) return { key: 'intro', value: m[1] };
  return null;
}

function splitAliases(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,，、;；]+/)) {
    // 先剥语言标注，再截长 —— 顺序反了会把标注截断、留下半个括号
    const v = part.trim().replace(ALIAS_NOTE_RE, '').trim().slice(0, 60);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

export function parseBioText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  const warnings = [];
  let cur = null;
  let mode = null;
  let sawFieldWithoutName = false;

  const nextMeaningful = (from) => {
    for (let j = from + 1; j < lines.length; j += 1) if (lines[j].trim()) return j;
    return -1;
  };

  const push = (value) => {
    if (!cur || !value) return;
    if (mode === 'aliases') {
      for (const a of splitAliases(value)) if (!cur.aliases.includes(a)) cur.aliases.push(a);
    } else if (mode === 'intro') {
      const seg = String(value).trim();
      if (!seg) return;
      cur.intro = cur.intro ? `${cur.intro}\n${seg}` : seg;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || SEPARATOR_RE.test(line)) {
      // 空行只有在简介里才保留成段落间隔，别的地方直接跳过
      if (cur && mode === 'intro' && cur.intro) cur.intro += '\n';
      continue;
    }

    const field = fieldOf(line);
    if (field) {
      if (!cur) {
        // 第一行就是「别名：」—— 没有名字可用，跳过并提示
        if (!sawFieldWithoutName) warnings.push('开头有「别名 / 简介」但缺少条目名');
        sawFieldWithoutName = true;
        continue;
      }
      mode = field.key;
      push(field.value);
      continue;
    }

    const nxt = nextMeaningful(i);
    const nxtIsField = nxt >= 0 && fieldOf(lines[nxt].trim()) !== null;
    if (nxtIsField) {
      // 下一行是字段行 → 这一行是新条目的名字
      cur = { name: line.replace(BULLET_RE, '').trim().slice(0, 100), aliases: [], intro: '' };
      items.push(cur);
      mode = null;
      continue;
    }

    // 其余非空行：简介 / 别名的续行（大段简介被拆成多行时会走到这里）
    if (cur && mode) push(line);
    else if (line) warnings.push(`第 ${i + 1} 行没有归属：「${line.slice(0, 18)}」`);
  }

  const out = items.filter((x) => x.name && (x.aliases.length || x.intro));
  for (const x of out) x.intro = x.intro.replace(/\n{3,}/g, '\n\n').trim();
  return { items: out, warnings };
}
