/**
 * 小说库的表单字段。
 *
 * 两条入口：首页「新建 / 编辑小说」，详情页「编辑资料」。
 * 字段以前各写一份，加个「作者」很容易只加在一边 —— 这里出唯一的一份定义。
 *
 * `transform` 负责把「万字」换算成「字」（库里存原始字数）。
 */

/** 原创书的常用类型；datalist 可手输，没列出来的照样能用 */
export const ORIGIN_TYPES = [
  '玄幻',
  '仙侠',
  '都市',
  '言情',
  '历史',
  '科幻',
  '悬疑',
  '奇幻',
  '军事',
  '游戏竞技',
  '文学',
];

export const STATUS = ['连载', '完结', '暂停'];

/**
 * @param {object} o
 * @param {boolean} o.fan    同人书（原作 + 篇幅）还是原创书（类型 + 出版方式）
 * @param {string[]} o.groups 归类文件夹的可选值（同人=原作品名，原创=已有类型）
 * @param {object|null} o.item 编辑已有小说时传入
 *
 * 六个字段两栏排（`half: true`），简介整行 —— 单列排下来太高，弹窗底部会被遮住。
 */
export function novelFieldSet({ fan = false, groups = [], item = null, defaults = null } = {}) {
  const it = item || {};
  const def = defaults || {};
  const fields = [
    {
      name: 'name',
      label: '书名',
      required: true,
      half: true,
      value: it.name || '',
      placeholder: fan ? '比如：提瓦特纪事' : '比如：斗破苍穹',
      hint: item ? '' : '一次建多本用逗号隔开',
    },
    {
      name: 'novelGroup',
      label: fan ? '原作品' : '小说类型',
      type: 'datalist',
      required: true,
      half: true,
      // 不填就留空，别被静默填成第一个选项
      allowEmpty: true,
      options: groups,
      value: it.novelGroup || def.novelGroup || '',
      placeholder: fan ? '比如：原神' : '比如：玄幻',
      hint: fan ? '会自动打上同名标签' : '会作为磁盘文件夹名',
    },
    {
      name: 'novelSubtype',
      label: fan ? '篇幅' : '出版方式',
      type: 'select',
      required: true,
      half: true,
      options: fan ? ['短篇', '长篇'] : ['出版', '网络'],
      value: it.novelSubtype || (fan ? '短篇' : '网络'),
    },
    { name: 'author', label: '作者', half: true, value: it.author || '', placeholder: '选填' },
    {
      name: 'wordCount',
      label: '字数（万字）',
      half: true,
      value: it.wordCount ? String(Math.round((it.wordCount / 10000) * 10) / 10) : '',
      placeholder: '选填，比如 53.6',
    },
    {
      name: 'novelStatus',
      label: '状态',
      type: 'select',
      half: true,
      options: STATUS,
      value: it.novelStatus || '完结',
    },
    // 小说没有「别名」：原名 / 译名这种信息直接写进简介就行
    { name: 'intro', label: '简介', type: 'textarea', rows: 4, value: it.intro || '', placeholder: '选填' },
  ];

  const transform = (val) => ({
    name: String(val.name || '').trim(),
    novelGroup: String(val.novelGroup || '').trim(),
    novelSubtype: val.novelSubtype || '',
    author: String(val.author || '').trim(),
    wordCount: Math.round((Number(val.wordCount) || 0) * 10000),
    novelStatus: val.novelStatus || '',
    intro: val.intro || '',
  });

  // 双栏弹窗比默认的 460 宽：两列各留 ~310px
  return { fields, transform, className: 'form-wide' };
}
