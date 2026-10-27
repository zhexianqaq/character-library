/**
 * 跨角色搬运文件的「意图记录」（journal）。
 *
 * 跨角色移动不能是一个原子操作：文件在磁盘上动，记录在 SQLite 里改，两者没法一起提交。
 * 所以先落一条意图，再做文件移动，最后更新数据库 —— 每步之间进程被杀，下次启动还能收尾：
 *
 *   pending-moves/<mediaId>-<rand>.json   { mediaId, fromRel, toRel, at }
 *
 * 启动时 `recoverPendingMoves()` 逐条对照数据库：
 *   - 数据库已经指到 toRel  → 说明事务提交过了，只是没来得及删记录 → 删记录
 *   - 数据库还指 fromRel    → 事务没提交：文件若已在 toRel，搬回 fromRel（回到操作前的状态）
 *   - 媒体记录已被删掉      → 能搬回就搬回，避免文件凭空留在别的角色目录里
 *
 * 搬不回去的会留在 pending 目录里，并追加一行到 `recovery.log`，人工可以照着处理。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CATALOG_DIR } from './config.js';
import { absPathOf, moveFile } from './store.js';

export const PENDING_DIR = path.join(CATALOG_DIR, 'pending-moves');
export const RECOVERY_LOG = path.join(CATALOG_DIR, 'recovery.log');

function ensureDir() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
}

/** 追加一条可追溯的记录（JSONL，一行一件事） */
export async function logRecovery(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.mkdirSync(CATALOG_DIR, { recursive: true });
    await fsp.appendFile(RECOVERY_LOG, line, 'utf8');
  } catch {
    console.error('[recovery]', line.trim());
  }
}

/** 文件移动之前先写意图；返回删除函数 */
export async function beginMove({ mediaId, fromRel, toRel }) {
  ensureDir();
  const file = path.join(PENDING_DIR, `${mediaId}-${crypto.randomUUID().slice(0, 8)}.json`);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify({ mediaId, fromRel, toRel, at: new Date().toISOString() });
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, file);
  return async () => {
    await fsp.unlink(file).catch(() => {});
  };
}

async function readPending() {
  let names = [];
  try {
    names = await fsp.readdir(PENDING_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const abs = path.join(PENDING_DIR, n);
    try {
      const j = JSON.parse(await fsp.readFile(abs, 'utf8'));
      if (j && j.mediaId && j.fromRel && j.toRel) out.push({ file: abs, ...j });
    } catch {
      // 半个文件（写到一半崩了）：留着不动，交给人工；日志里能看见
      await logRecovery({ kind: 'pending-unreadable', file: abs });
    }
  }
  return out;
}

/**
 * 启动时收尾未完成的搬运。
 * @param {import('better-sqlite3').Database} db
 */
export async function recoverPendingMoves(db) {
  const items = await readPending();
  const result = { scanned: items.length, committed: 0, rolledBack: 0, failed: 0, details: [] };

  for (const it of items) {
    const row = db.prepare('SELECT id, rel_path FROM media WHERE id = ?').get(it.mediaId);
    const fromAbs = absPathOf(it.fromRel);
    const toAbs = absPathOf(it.toRel);
    const finish = async (kind, detail) => {
      await fsp.unlink(it.file).catch(() => {});
      result[kind] += 1;
      result.details.push(`${it.mediaId}: ${detail}`);
      if (kind === 'failed') await logRecovery({ kind: 'move-rollback-failed', ...it, detail });
    };

    if (row && row.rel_path === it.toRel) {
      await finish('committed', '数据库已指向新位置，只差删记录');
      continue;
    }
    if (!row) {
      // 记录被删了：文件还在新位置就搬回去，避免变成别人目录里的孤儿
      if (!fs.existsSync(fromAbs) && fs.existsSync(toAbs)) {
        try {
          await moveFile(toAbs, fromAbs);
          await finish('rolledBack', '记录已删除，文件搬回原处');
        } catch (err) {
          await finish('failed', `记录已删除但文件搬不回去：${err.message}`);
        }
      } else {
        await finish('rolledBack', '记录已删除，无需处理文件');
      }
      continue;
    }

    // 数据库还指着旧位置：事务没提交
    if (fs.existsSync(fromAbs)) {
      await finish('rolledBack', '文件仍在原处，无需处理');
      continue;
    }
    if (!fs.existsSync(toAbs)) {
      await finish('failed', '源和目标都找不到文件，需人工确认');
      continue;
    }
    try {
      await moveFile(toAbs, fromAbs);
      await finish('rolledBack', '文件已搬回原处');
    } catch (err) {
      await finish('failed', `文件搬回失败：${err.message}`);
    }
  }

  if (result.scanned) {
    console.log(
      `  搬运日志  扫描 ${result.scanned} 条 · 已提交 ${result.committed} · 已回滚 ${result.rolledBack} · 失败 ${result.failed}`
    );
  }
  return result;
}
