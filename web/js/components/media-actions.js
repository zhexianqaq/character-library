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

async function removeMedia(item, onChange) {
  const ok = await confirmDialog('删除这个媒体？', '磁盘上的原文件也会一起删除，不可恢复。');
  if (!ok) return;
  await api.deleteMedia(item.id);
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
  { characterId, onOpen, onChange, pack = null, owner = null, onCover = null } = {}
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
    { label: '移动到其他图包', onClick: () => moveMedia(item, characterId, onChange) },
    { separator: true },
    { label: '删除', danger: true, onClick: () => removeMedia(item, onChange) },
  ]);
}
