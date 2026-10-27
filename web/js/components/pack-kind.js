import { api } from '../api.js';
import { toast } from '../util.js';
import { confirmDialog } from './modal.js';

/**
 * 图包 ⇄ 漫画 的切换（图包页和条目页共用）。
 *
 * 只改 packs.kind 和 media.page_no，文件不搬、封面和标签不动，所以随时能转回去。
 * 包里有视频时后端会回 409：先告诉用户有几个视频，确认后只转图片，
 * 视频留在包里（不进阅读器，但也没丢）。
 *
 * @returns {Promise<boolean>} 是否真的改了（调用方据此决定要不要刷新）
 */
export async function togglePackKind(pack) {
  if (!pack || pack.kind === 'novel') {
    toast('小说袋不能转成漫画');
    return false;
  }

  if (pack.kind === 'comic') {
    const ok = await confirmDialog(
      '转回普通图包？',
      '页序会被清空，图片顺序回到图包原来的排序；文件、封面、标签都不动。'
    );
    if (!ok) return false;
    try {
      await api.convertPack(pack.id, 'pack');
      toast('已转回普通图包');
      return true;
    } catch (err) {
      toast(err.message || '转换失败');
      return false;
    }
  }

  try {
    const r = await api.convertPack(pack.id, 'comic');
    toast(`已转为漫画 · ${r.pages} 页`);
    return true;
  } catch (err) {
    if (err.status !== 409) {
      toast(err.message || '转换失败');
      return false;
    }
    const vids = (err.body && err.body.videos) || 0;
    const ok = await confirmDialog(
      `包里有 ${vids || '几'} 个视频，只转换图片？`,
      `这些视频会留在图包里，不参与漫画阅读（也不会丢），需要的话之后可以单独移出去。`
    );
    if (!ok) return false;
    try {
      const r = await api.convertPack(pack.id, 'comic', { onlyImages: true });
      toast(`已转为漫画 · ${r.pages} 页${r.videos ? ` · ${r.videos} 个视频未参与` : ''}`);
      return true;
    } catch (e2) {
      toast(e2.message || '转换失败');
      return false;
    }
  }
}
