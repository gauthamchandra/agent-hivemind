import type { UnitOfWork } from '@/ports/storage.ts';
import { count, readOccupancy } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { one, readNumber } from '@/storage/postgres/store-query.ts';

export function counterWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'occupancy'
  | 'addOccupancy'
  | 'spawnCount'
  | 'insertSpawn'
  | 'holderCount'
  | 'liveOnTask'
  | 'replacementCount'
  | 'nextAttempt'
  | 'implementerEverStarted'
> {
  return {
    occupancy(workspaceId, groupId) {
      return readOccupancy(sql, workspaceId, groupId);
    },
    async addOccupancy(workspaceId, groupId, delta) {
      await sql.query(
        `UPDATE groups SET
           live_sessions = live_sessions + $3,
           live_planner = live_planner + $4,
           live_challenger = live_challenger + $5,
           live_implementer = live_implementer + $6,
           total_sessions = total_sessions + $7
         WHERE workspace_id = $1 AND id = $2`,
        [
          workspaceId,
          groupId,
          delta.live_sessions,
          delta.planner,
          delta.challenger,
          delta.implementer,
          delta.total_sessions,
        ]
      );
      await sql.query('UPDATE workspaces SET live_sessions = live_sessions + $2 WHERE id = $1', [
        workspaceId,
        delta.live_sessions,
      ]);
    },
    spawnCount(groupId, since) {
      return count(
        sql,
        'SELECT count(*)::int AS count FROM spawn_log WHERE group_id = $1 AND at >= $2::timestamptz',
        [groupId, since]
      );
    },
    async insertSpawn(row) {
      await sql.query(
        `INSERT INTO spawn_log (id, workspace_id, group_id, session_id, at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)`,
        [row.id, row.workspaceId, row.groupId, row.sessionId, row.at]
      );
    },
    holderCount(taskId, role) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND life IN ('starting', 'live', 'released')`,
        [taskId, role]
      );
    },
    liveOnTask(taskId, role) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND life IN ('starting', 'live')`,
        [taskId, role]
      );
    },
    replacementCount(taskId, role) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND attempt > 1 AND life <> 'start_failed'`,
        [taskId, role]
      );
    },
    async nextAttempt(taskId, role) {
      const row = await one(
        sql,
        `SELECT COALESCE(MAX(attempt), 0)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND life <> 'start_failed'`,
        [taskId, role]
      );

      return readNumber(row ?? {}, 'count') + 1;
    },
    async implementerEverStarted(groupId) {
      const row = await one(
        sql,
        `SELECT 1 AS present FROM sessions
         WHERE group_id = $1 AND role = 'implementer' AND life <> 'start_failed'
         LIMIT 1`,
        [groupId]
      );

      return row !== null;
    },
  };
}
