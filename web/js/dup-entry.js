import { openModal } from './components/modal.js';

/**
 * 同库重名。服务端 409 带已有条目的 id。
 * 弹窗说明原因，由用户决定要不要打开那一条，不自动跳走。
 */
export async function offerExistingEntry(name, id) {
  const ok = await openModal({
    title: `这个库里已经有「${name}」`,
    description: '同一个库不能有两个同名条目。别名不算重名，别的库可以同名。',
    submitText: '打开已有条目',
  });
  if (!ok || !id) return false;
  history.pushState({}, '', `/c/${id}`);
  window.dispatchEvent(new CustomEvent('app:route'));
  return true;
}
