import type { PlannedAction } from '@/domain/background-jobs.ts';
import { isJobName, jobLockCheckMs, jobLockMs } from '@/domain/background-jobs.ts';
import { requireWorkspaceId } from '@/domain/ids.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import {
  many,
  one,
  readNullableTime,
  readNumber,
  readString,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function jobLocks(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'takeJobLock'
  | 'holdJobLock'
  | 'jobLockStartedAt'
  | 'insertPlannedAction'
  | 'openPlannedActions'
  | 'finishPlannedAction'
> {
  return {
    async takeJobLock(input) {
      const row = await one(
        sql,
        `INSERT INTO job_locks (job, locked_by, expires_at, lock_id, last_started_at)
         VALUES ($1, $2, $3::timestamptz, 1, $4::timestamptz)
         ON CONFLICT (job) DO UPDATE
         SET locked_by = EXCLUDED.locked_by,
             expires_at = EXCLUDED.expires_at,
             lock_id = job_locks.lock_id + 1,
             last_started_at = EXCLUDED.last_started_at
         WHERE job_locks.expires_at <= $4::timestamptz
           AND job_locks.last_started_at <= $5::timestamptz
         RETURNING lock_id`,
        [input.job, input.lockedBy, input.expiresAt, input.now, input.dueAt]
      );

      return row === null ? null : readNumber(row, 'lock_id');
    },

    async holdJobLock(job, lockId, now) {
      return renewJobLock(sql, job, lockId, now);
    },

    async jobLockStartedAt(job) {
      const row = await one(sql, 'SELECT last_started_at FROM job_locks WHERE job = $1', [job]);

      return row === null ? null : readNullableTime(row.last_started_at);
    },

    async insertPlannedAction(input) {
      const held = await renewJobLock(sql, input.job, input.lockId, input.now);

      if (!held) return 'stale';

      const open = await one(
        sql,
        `SELECT id FROM planned_actions
         WHERE job = $1 AND action = $2 AND target_id = $3 AND state = 'open'`,
        [input.job, input.action, input.targetId]
      );

      if (open !== null) return 'open';

      await sql.query(
        `INSERT INTO planned_actions (
           id, job, action, target_id, workspace_id, lock_id, state, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::timestamptz)`,
        [
          input.id,
          input.job,
          input.action,
          input.targetId,
          input.workspaceId,
          input.lockId,
          input.now,
        ]
      );

      return 'inserted';
    },

    async openPlannedActions(job) {
      const rows = await many(
        sql,
        `SELECT id, job, action, target_id, workspace_id, lock_id, state
         FROM planned_actions WHERE job = $1 AND state = 'open' ORDER BY created_at, id`,
        [job]
      );

      return rows.map(parsePlannedAction);
    },

    async finishPlannedAction(id, job, lockId, now) {
      if (!(await renewJobLock(sql, job, lockId, now))) return false;

      const row = await one(
        sql,
        `UPDATE planned_actions
         SET state = 'done', finished_at = $2::timestamptz
         WHERE id = $1 AND state = 'open'
         RETURNING id`,
        [id, now]
      );

      return row !== null;
    },
  };
}

async function renewJobLock(sql: Sql, job: string, lockId: number, now: string): Promise<boolean> {
  const row = await one(
    sql,
    `UPDATE job_locks
     SET expires_at = CASE
       WHEN expires_at <= $3::timestamptz + ($4::bigint * interval '1 millisecond')
       THEN $3::timestamptz + ($5::bigint * interval '1 millisecond')
       ELSE expires_at
     END
     WHERE job = $1 AND lock_id = $2
     RETURNING lock_id`,
    [job, lockId, now, jobLockCheckMs, jobLockMs]
  );

  return row !== null;
}

function parsePlannedAction(row: Row): PlannedAction {
  const job = readString(row, 'job');
  const state = readString(row, 'state');

  if (!isJobName(job) || (state !== 'open' && state !== 'done')) throw unreadable();

  return {
    id: readString(row, 'id'),
    job,
    action: readString(row, 'action'),
    targetId: readString(row, 'target_id'),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    lockId: readNumber(row, 'lock_id'),
    state,
  };
}
