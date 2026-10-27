/**
 * 把「崩坏」这个合并作品拆成 崩坏3 / 崩坏：星穹铁道。
 *
 *   node tools/_split-bengbuai.mjs           只列名单（dry-run）
 *   node tools/_split-bengbuai.mjs --apply   改出处 + 改标签 + 删「崩坏」作品卡
 *
 * 判定依据：官方可玩名单（星穹铁道 1.0–4.2 全角色）+ 崩坏3 女武神/主线 NPC。
 * 名字里带全名（布洛妮娅·扎伊切克 / 希儿·芙乐艾 / 娜塔莎·希奥拉 / 李素裳）的是崩坏3，
 * 而同名短版（布洛妮娅 / 希儿 / 娜塔莎 / 素裳）是星穹铁道 —— 名单里两版都在，正好互为对照。
 */
const HSR = new Set([
  // 星穹列车 / 空间站 / 贝洛伯格 / 仙舟 / 匹诺康尼 / 翁法罗斯
  '三月七', '星', '姬子', '布洛妮娅', '希儿', '克拉拉', '娜塔莎', '佩拉', '希露瓦', '虎克',
  '停云', '素裳', '青雀', '白露', '驭空', '符玄', '镜流', '雪衣', '寒鸦', '桂乃芬',
  '玲可', '托帕', '知更鸟', '花火', '黑天鹅', '黄泉', '流萤', '翡翠', '云璃', '飞霄',
  '灵砂', '乱破', '藿藿', '银狼', '卡芙卡', '黑塔', '艾丝妲', '幻胧', '真珠',
  '阿格莱雅', '缇宝', '遐蝶', '风堇', '赛飞儿', '海瑟音', '刻律德菈', '昔涟', '长夜月',
  '大丽花', '火花', '爻光', '绯英', '阮·梅',
  // 联动
  'Saber', '远坂凛',
  // 仙舟 NPC（名字风格与已知 NPC 一致）
  '丹枢', '净砚', '青镞', '玉络', '锦纹', '连烟', '雾生', '蒲儿', '蒂索克三世',
]);

const HI3_UNCERTAIN = new Set([
  '乌玛', '乔凡娜', '克劳迪娅', '卢克雷提娅', '夕葵', '奥科萨娜', '娜尔娜', '安赛蜜',
  '小空', '布琳娜', '布罗娜', '康娜', '拉洛丝', '斯薇塔', '查令', '柯柯娜', '梦茗',
  '泠泠', '温世玲', '燕翠', '科琳', '缇米朵', '艾丽', '艾丽斯', '艾薇拉', '芙尔拉',
  '若月', '莉拉', '莉维娅', '莎芙莱', '莱拉', '萨宾娜', '蒂玛·声波', '蕾耶拉', '西娅',
  '谭雅', '贝拉', '辛格勒', '阿婕塔', '松雀',
]);

const BASE = 'http://127.0.0.1:7788';
const j = async (u, o) => {
  const r = await fetch(BASE + u, o);
  const t = await r.text();
  let body = null;
  try { body = t ? JSON.parse(t) : null; } catch { body = t; }
  return { status: r.status, body };
};
const patch = (u, d) =>
  j(u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });

const chars = (await j('/api/shelves/2/characters?sort=name')).body.items || [];
const affected = chars.filter(
  (c) => (c.tags || []).includes('崩坏') || (c.platforms || []).some((p) => p.handle === '崩坏')
);
console.log(`带「崩坏」的条目 ${affected.length} 个`);

const toHSR = affected.filter((c) => HSR.has(c.name));
const toHI3 = affected.filter((c) => !HSR.has(c.name));
const unsure = toHI3.filter((c) => HI3_UNCERTAIN.has(c.name));
console.log(`→ 崩坏：星穹铁道 ${toHSR.length} 个`);
console.log(`→ 崩坏3        ${toHI3.length} 个（其中 ${unsure.length} 个我没把握，先放这边）`);
console.log('\n拿不准的：' + unsure.map((c) => c.name).join('、'));

if (!process.argv.includes('--apply')) {
  console.log('\n（dry-run，未改数据）');
} else {
  let ok = 0;
  let bad = 0;
  for (const [list, work] of [
    [toHSR, '崩坏：星穹铁道'],
    [toHI3, '崩坏3'],
  ]) {
    for (const c of list) {
      const platforms = (c.platforms || []).map((p) =>
        p.handle === '崩坏' ? { ...p, handle: work } : p
      );
      if (!platforms.some((p) => p.handle === work)) platforms.push({ platform: '游戏', handle: work, url: '' });
      const tags = [...new Set((c.tags || []).map((t) => (t === '崩坏' ? work : t)))];
      if (!tags.includes(work)) tags.push(work);
      const r = await patch(`/api/characters/${c.id}`, { platforms, tags });
      if (r.status === 200) ok += 1;
      else {
        bad += 1;
        console.log('  失败', c.name, r.status, r.body && r.body.error);
      }
    }
  }
  console.log(`\n改完 ${ok} 个，失败 ${bad} 个`);

  // 删掉「崩坏」作品卡（标签会在删完后由 pruneOrphanTags 清掉）
  const res = (await j('/api/shelves/4/resources')).body.items || [];
  const gu = res.filter((r) => r.name === '崩坏');
  for (const r of gu) {
    const d = await j(`/api/characters/${r.id}`, { method: 'DELETE' });
    console.log(`删除作品卡「崩坏」(${r.id}) → ${d.status} ${JSON.stringify(d.body)}`);
  }
  const after = (await j('/api/shelves/4/resources')).body.items || [];
  const pick = after.filter((r) => r.name.startsWith('崩坏'));
  console.log(pick.map((r) => `${r.name} 关联=${r.linked}`).join(' | '));
}
