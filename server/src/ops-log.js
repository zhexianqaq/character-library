/**
 * 磁盘操作日志（v3.46）。
 *
 * 目的：前端每次动文件夹 / 文件都留一条记录，**长久保存**。
 * 同步按钮只处理这里「没落实的」和「还没校验过的」，不再全库扫描。
 *
 * 硬规矩：
 *   - 记录和业务改动**写在同一个事务里**（进程被杀也不丢）
 *   - payload 存**路径快照**：记录删了也要知道该动哪些文件
 *   - `done` 不等于「磁盘一定对」，只是「执行时没报错」；同步会用 verified_at 再核一遍
 */
import { nowIso } from './db.js';

/**
 * 这些动作「只改库、同步时才落盘」，插入时就是 pending。
 *
 * P0 阶段这里是空的（记录全部 done，行为零变化）；P1 打开这三个。
 * 用集合而不是散落的 if，方便一次性开关 / 回滚。
 */
export const DEFERRED_ACTIONS = new Set([
  'pack.create',   // 新建图包：同步时补空目录
  'media.move',    // 同条目内搬包：同步时才搬文件
  'pack.dissolve', // 解散：素材归入「未分类」，同步时才搬
  'dir.prune',     // 搬完留下的空目录：同步时统一收
]);

/** 这个动作是否属于「延迟落盘」 */
export const isDeferred = (action) => DEFERRED_ACTIONS.has(action);

/** 初始状态：延迟动作 pending，其它按调用方给的结果（默认 done） */
export function initialStatus(action, result = 'done') {
  return isDeferred(action) ? 'pending' : result;
}

/**
 * 写一条操作日志。
 * @param {object} db better-sqlite3
 * @param {object} o { entity, entityId, action, payload, status, reason, source }
 */
export function logOp(
  db,
  { source = 'ui', entity, entityId = null, action, payload = {}, status = 'done', reason = null }
) {
  const now = nowIso();
  // action 统一存成 "entity.action"（pack.create / media.move / dir.prune），
  // 调用方写 'create' 还是 'pack.create' 都能落成同一个键
  const act = String(action || '').includes('.') ? String(action) : `${entity}.${action}`;
  const info = db
    .prepare(
      `INSERT INTO fs_ops(created_at, source, entity, entity_id, action, payload, status, reason, applied_at, attempts)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      now,
      source,
      entity,
      entityId === null || entityId === undefined ? null : Number(entityId),
      act,
      JSON.stringify(payload == null ? {} : payload),
      status,
      reason,
      status === 'done' ? now : null,
      status === 'failed' ? 1 : 0
    );
  return Number(info.lastInsertRowid);
}

/** 改状态（执行完回写成功/失败） */
export function setOpStatus(db, id, status, reason = null) {
  const now = nowIso();
  db.prepare(
    `UPDATE fs_ops
       SET status = ?, reason = ?,
           attempts = attempts + CASE WHEN ? = 'failed' THEN 1 ELSE 0 END,
           applied_at = CASE WHEN ? = 'done' THEN COALESCE(applied_at, ?) ELSE applied_at END
     WHERE id = ?`
  ).run(status, reason, status, status, now, id);
}

/** 校验通过：记 verified_at（同步器用） */
export function markVerified(db, ids) {
  if (!ids || !ids.length) return 0;
  const now = nowIso();
  const st = db.prepare(`UPDATE fs_ops SET verified_at = ? WHERE id = ? AND status = 'done'`);
  const tx = db.transaction((list) => {
    for (const id of list) st.run(now, id);
  });
  tx(ids);
  return ids.length;
}

/** 待处理（含失败的）—— 同步要应用的就是这些 */
export function openOps(db) {
  return db.prepare(`SELECT * FROM fs_ops WHERE status IN ('pending','failed') ORDER BY id`).all();
}

/** 上次同步之后发生、还没校验过的 */
export function unverifiedOps(db) {
  return db.prepare(`SELECT * FROM fs_ops WHERE status = 'done' AND verified_at IS NULL ORDER BY id`).all();
}

/** 角标与弹窗用的汇总 */
export function opsSummary(db) {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'done' AND verified_at IS NULL THEN 1 ELSE 0 END) AS unverified,
         COUNT(*) AS total
       FROM fs_ops`
    )
    .get();
  const byAction = db
    .prepare(
      `SELECT action, status, COUNT(*) AS n FROM fs_ops
       WHERE status IN ('pending','failed')
       GROUP BY action, status`
    )
    .all();
  return {
    pending: row.pending || 0,
    failed: row.failed || 0,
    unverified: row.unverified || 0,
    total: row.total || 0,
    byAction,
  };
}

/** 操作记录列表（P3 的记录页用） */
export function listOps(db, { limit = 100, offset = 0, status = '', q = '' } = {}) {
  const where = [];
  const params = { limit: Math.min(500, Math.max(1, Number(limit) || 100)), offset: Math.max(0, Number(offset) || 0) };
  if (status) {
    where.push('status = @status');
    params.status = String(status);
  }
  if (q) {
    where.push('(action LIKE @q OR entity LIKE @q OR payload LIKE @q OR reason LIKE @q)');
    params.q = `%${String(q)}%`;
  }
  const sql = `SELECT * FROM fs_ops ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY id DESC LIMIT @limit OFFSET @offset`;
  const items = db.prepare(sql).all(params).map((r) => ({ ...r, payload: safeParse(r.payload) }));
  const total = db
    .prepare(`SELECT COUNT(*) n FROM fs_ops ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .get(params).n;
  return { items, total };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** 一次同步运行的记录 */
export function startRun(db, mode = 'incremental') {
  const info = db
    .prepare(`INSERT INTO fs_sync_runs(started_at, mode) VALUES(?,?)`)
    .run(nowIso(), mode);
  return Number(info.lastInsertRowid);
}

export function finishRun(db, id, stats) {
  db.prepare(
    `UPDATE fs_sync_runs
       SET finished_at = ?, applied = ?, verified = ?, repaired = ?, failed = ?,
           files_moved = ?, dirs_removed = ?, note = ?
     WHERE id = ?`
  ).run(
    nowIso(),
    stats.applied || 0,
    stats.verified || 0,
    stats.repaired || 0,
    stats.failed || 0,
    stats.filesMoved || 0,
    stats.dirsRemoved || 0,
    stats.note || null,
    id
  );
}

/** 归档：删掉 N 天前、已经校验过的记录（默认 365 天） */
export function archiveOps(db, days = 365) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 365) * 86400000).toISOString();
  const info = db
    .prepare(`DELETE FROM fs_ops WHERE status = 'done' AND verified_at IS NOT NULL AND created_at < ?`)
    .run(cutoff);
  return info.changes;
}
