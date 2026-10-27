import { api } from '../api.js';
import { openModal, confirmDialog } from './modal.js';
import { openTagPicker } from './tag-picker.js';
import { openContextMenu } from './context-menu.js';
import { toast } from '../util.js';

async function renameMedia(item, onChange) {
  const v = await openModal({
    title: '重命名',
    description: '只改库里的显示名，磁盘上的文件保持不动。',
    fields: [{ name: 'fileName', label: '文件名', value: item.fileName || '', required: true }],
    submitText: '保存',
  });
  if (!v) return;
  await api.updateMedia(item.id, { fileName: v.fileName });
  toast('已重命名');
  onChange && onChange();
}

async function editMediaTags(item, onChange) {
  const next = await openTagPicker({ title: '编辑图片标签', selected: item.ownTags || [] });
  if (!next) return;
  await api.updateMedia(item.id, { tags: next });
  toast(next.length ? `已保存 ${next.length} 个标签` : '已清空标签');
  onChange && onChange();
}

async function moveMedia(item, characterId, onChange) {
  const data = await api.packs(characterId);
  const options = [{ value: '', label: '（移出图包，变成未归包）' }];
  for (const p of data.items) {
    options.push({ value: String(p.id), label: `${p.category ? p.category + ' / ' : ''}${p.title}` });
  }
  const v = await openModal({
    title: '移动到其他图包',
    fields: [
      {
        name: 'packId',
        label: '目标图包',
        type: 'select',
        options,
        value: item.packId ? String(item.packId) : '',
      },
    ],
    submitText: '移动',
  });
  if (!v) return;
  await api.updateMedia(item.id, { packId: v.packId ? Number(v.packId) : null });
  toast('已移动');
  onChange && onChange();
}

/**
 * 移出库：从当前条目 / 图包退回到「全部库 → 未分发」，文件真的搬过去。
 * 「全部库」里本来就有同一份内容时，后端只留一份（记录合并），这里照实提示。
 */
async function ejectMedia(item, onChange) {
  const ok = await confirmDialog(
    '把这张移出当前库？',
    '会从条目 / 图包里移到「全部库 → 未分发」，之后可以在那里重新分发；磁盘上的文件跟着搬，不会复制。'
  );
  if (!ok) return;
  try {
    const r = await api.ejectMedia([item.id]);
    toast(r.merged ? '全部库里已有同一份文件，已合并（原条目这边移除）' : '已移到「全部库」');
    onChange && onChange();
  } catch (err) {
    toast(err.message || '移出失败');
  }
}

async function removeMedia(item, onChange) {
  const ok = await confirmDialog('删除这个媒体？', '磁盘上的原文件也会一起删除，不可恢复。');
  if (!ok) return;
  try {
    await api.deleteMedia(item.id);
  } catch (err) {
    // 文件被占用 / 只读：后端会保留记录并说明原因，别报「已删除」
    toast(err.message || '删除失败');
    return;
  }
  toast('已删除');
  onChange && onChange();
}

/** 设为图包封面：仅当这张图已经归属于某个图包时才出现 */
async function setPackCover(item, pack, onCover) {
  try {
    await api.updatePack(pack.id, { coverMediaId: item.id });
    toast(`已把这张设为「${pack.title}」的封面`);
    if (onCover) onCover('pack');
  } catch (err) {
    toast(err.message || '设置封面失败');
  }
}

/** 设为角色 / 人物 / 资源封面：归属的条目是容器（表情库）时不出现 */
async function setOwnerCover(item, owner, onCover) {
  try {
    await api.updateCharacter(owner.id, { coverMediaId: item.id });
    toast(`已把这张设为「${owner.name}」的封面`);
    if (onCover) onCover('owner');
  } catch (err) {
    toast(err.message || '设置封面失败');
  }
}

/**
 * 媒体的右键菜单：改名 / 标签 / 设封面 / 打开文件夹 / 移动 / 删除
 *
 * 封面两项彼此独立、显示条件也不同：
 * - 设为图包封面：这张图当前归属于某个图包才显示，没有图包时**隐藏**（点了也无处可设，置灰只是噪音）
 * - 设为「人物 / 角色 / 资源」封面：图片归属的条目就是封面主体；表情库的容器条目没有"条目"这层，隐藏
 *
 * @param {object} ctx.pack   { id, title } | null
 * @param {object} ctx.owner  { id, name, noun } | null  noun 决定菜单文案（人物 / 角色 / 资源）
 * @param {(kind:'pack'|'owner')=>void} ctx.onCover 设好之后刷新展示区
 */
export function mediaMenu(
  event,
  item,
  { characterId, onOpen, onChange, pack = null, owner = null, onCover = null, shelfKind = '', allowMove = true } = {}
) {
  const packRef = pack || (item.packId ? { id: item.packId, title: item.packTitle || '这个图包' } : null);
  const ownerRef = owner && owner.id ? owner : null;
  const ownerNoun = (ownerRef && ownerRef.noun) || '条目';

  openContextMenu(event, [
    { label: '打开', onClick: () => onOpen && onOpen() },
    { label: '重命名', onClick: () => renameMedia(item, onChange) },
    { label: '编辑标签', onClick: () => editMediaTags(item, onChange) },
    packRef ? { label: '设为图包封面', hint: packRef.title, onClick: () => setPackCover(item, packRef, onCover) } : null,
    ownerRef ? { label: `设为${ownerNoun}封面`, hint: ownerRef.name, onClick: () => setOwnerCover(item, ownerRef, onCover) } : null,
    { label: '打开本地文件夹', onClick: () => api.reveal('media', item.id).catch(() => toast('文件已丢失')) },
    { separator: true },
    // 全部库里的素材没有图包可去（pack_id 一律为空），这一项没意义
    allowMove ? { label: '移动到其他图包', onClick: () => moveMedia(item, characterId, onChange) } : null,
    // 已经在「全部库」里的没必要再移一次
    shelfKind === 'inbox' ? null : { label: '移出库', hint: '放到全部库', onClick: () => ejectMedia(item, onChange) },
    { separator: true },
    { label: '删除', danger: true, onClick: () => removeMedia(item, onChange) },
  ]);
}
