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

/** 媒体的右键菜单：改名 / 标签 / 打开文件夹 / 移动 / 删除 */
export function mediaMenu(event, item, { characterId, onOpen, onChange } = {}) {
  openContextMenu(event, [
    { label: '打开', onClick: () => onOpen && onOpen() },
    { label: '重命名', onClick: () => renameMedia(item, onChange) },
    { label: '编辑标签', onClick: () => editMediaTags(item, onChange) },
    { label: '打开本地文件夹', onClick: () => api.reveal('media', item.id).catch(() => toast('文件已丢失')) },
    { separator: true },
    { label: '移动到其他图包', onClick: () => moveMedia(item, characterId, onChange) },
    { separator: true },
    { label: '删除', danger: true, onClick: () => removeMedia(item, onChange) },
  ]);
}
