import { requireWorkspaceId } from '@/domain/ids.ts';
import type { JobIntent } from '@/domain/supervision.ts';
import { isJobName, leaseMs, leaseRenewMs } from '@/domain/supervision.ts';
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

export function supervisionLease(
  sql: Sql
): Pick<
  UnitOfWork,
  'takeLease' | 'holdLease' | 'leaseStartedAt' | 'insertIntent' | 'intents' | 'finishIntent'
> {
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
      return renewLease(sql, job, epoch, now);
    },

    async leaseStartedAt(job) {
      const row = await one(sql, 'SELECT last_started_at FROM leases WHERE job = $1', [job]);

      return row === null ? null : readNullableTime(row.last_started_at);
    },

    async insertIntent(input) {
      const held = await renewLease(sql, input.job, input.epoch, input.now);

      if (!held) return 'stale';

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
      if (!(await renewLease(sql, job, epoch, now))) return false;

      const row = await one(
        sql,
        `UPDATE job_intents
         SET state = 'done', finished_at = $2::timestamptz
         WHERE id = $1 AND state = 'open'
         RETURNING id`,
        [id, now]
      );

      return row !== null;
    },
  };
}

async function renewLease(sql: Sql, job: string, epoch: number, now: string): Promise<boolean> {
  const row = await one(
    sql,
    `UPDATE leases
     SET expires_at = CASE
       WHEN expires_at <= $3::timestamptz + ($4::bigint * interval '1 millisecond')
       THEN $3::timestamptz + ($5::bigint * interval '1 millisecond')
       ELSE expires_at
     END
     WHERE job = $1 AND epoch = $2
     RETURNING epoch`,
    [job, epoch, now, leaseRenewMs, leaseMs]
  );

  return row !== null;
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
