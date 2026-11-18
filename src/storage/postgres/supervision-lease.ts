import { requireWorkspaceId } from '@/domain/ids.ts';
import type { JobIntent } from '@/domain/supervision.ts';
import { isJobName } from '@/domain/supervision.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import { many, one, readNumber, readString, unreadable } from '@/storage/postgres/store-query.ts';

export function supervisionLease(
  sql: Sql
): Pick<UnitOfWork, 'takeLease' | 'holdLease' | 'insertIntent' | 'intents' | 'finishIntent'> {
  return {
    async takeLease(input) {
      const row = await one(
        sql,
        `INSERT INTO leases (job, holder, expires_at, epoch, last_started_at)
         VALUES ($1, $2, $3::timestamptz, 1, $4::timestamptz)
         ON CONFLICT (job) DO UPDATE
         SET holder = EXCLUDED.holder,
             expires_at = EXCLUDED.expires_at,
             epoch = leases.epoch + 1,
             last_started_at = EXCLUDED.last_started_at
         WHERE leases.expires_at <= $4::timestamptz
           AND leases.last_started_at <= $5::timestamptz
         RETURNING epoch`,
        [input.job, input.holder, input.expiresAt, input.now, input.dueAt]
      );

      return row === null ? null : readNumber(row, 'epoch');
    },

    async holdLease(job, epoch, now) {
      const row = await one(
        sql,
        `SELECT epoch FROM leases
         WHERE job = $1 AND epoch = $2 AND expires_at > $3::timestamptz
         FOR UPDATE`,
        [job, epoch, now]
      );

      return row !== null;
    },

    async insertIntent(input) {
      const held = await one(
        sql,
        `SELECT epoch FROM leases
         WHERE job = $1 AND epoch = $2 AND expires_at > $3::timestamptz
         FOR UPDATE`,
        [input.job, input.epoch, input.now]
      );

      if (held === null) return 'stale';

      const open = await one(
        sql,
        `SELECT id FROM job_intents
         WHERE job = $1 AND action = $2 AND target_id = $3 AND state = 'open'`,
        [input.job, input.action, input.targetId]
      );

      if (open !== null) return 'open';

      await sql.query(
        `INSERT INTO job_intents (
           id, job, action, target_id, workspace_id, epoch, state, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::timestamptz)`,
        [
          input.id,
          input.job,
          input.action,
          input.targetId,
          input.workspaceId,
          input.epoch,
          input.now,
        ]
      );

      return 'inserted';
    },

    async intents(job) {
      const rows = await many(
        sql,
        `SELECT id, job, action, target_id, workspace_id, epoch, state
         FROM job_intents WHERE job = $1 ORDER BY created_at, id`,
        [job]
      );

      return rows.map(parseIntent);
    },

    async finishIntent(id, job, epoch, now) {
      const row = await one(
        sql,
        `UPDATE job_intents
         SET state = 'done', finished_at = $4::timestamptz
         WHERE id = $1 AND state = 'open'
           AND EXISTS (
             SELECT 1 FROM leases
             WHERE job = $2 AND epoch = $3 AND expires_at > $4::timestamptz
           )
         RETURNING id`,
        [id, job, epoch, now]
      );

      return row !== null;
    },
  };
}

function parseIntent(row: Row): JobIntent {
  const job = readString(row, 'job');
  const state = readString(row, 'state');

  if (!isJobName(job) || (state !== 'open' && state !== 'done')) throw unreadable();

  return {
    id: readString(row, 'id'),
    job,
    action: readString(row, 'action'),
    targetId: readString(row, 'target_id'),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    epoch: readNumber(row, 'epoch'),
    state,
  };
}
