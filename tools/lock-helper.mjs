/**
 * 测试辅助：用一个独立进程以「独占」方式打开文件，模拟「播放器 / 杀软正占着这个文件」。
 *
 * 为什么需要它：Node 的 fs.open 走 libuv，默认带 FILE_SHARE_DELETE，自己人根本挡不住删除；
 * 想验证「文件被占用时删除会失败」，只能找一个真的不共享删除的句柄。
 * 这里借 .NET 的 FileShare.None 来制造这种占用。
 *
 * 只在测试的临时目录里用，句柄会随进程退出自动释放。
 */
import { spawn } from 'node:child_process';

export function lockFileExclusive(absPath, seconds = 25) {
  const script =
    `$p=$env:CL_TEST_LOCK; ` +
    `$fs=[System.IO.File]::Open($p,'Open','Read','None'); ` +
    `Start-Sleep -Seconds ${Number(seconds) || 25}; ` +
    `$fs.Close()`;
  return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, CL_TEST_LOCK: absPath },
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** 等占用真的生效（PowerShell 启动 + 打开文件要几百毫秒） */
export async function waitLocked(absPath, timeoutMs = 8000) {
  const { openSync, closeSync } = await import('node:fs');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const fd = openSync(absPath, 'r+'); // 独占打开时，别人连写都写不进去
      closeSync(fd);
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return true;
    }
  }
  return false;
}
