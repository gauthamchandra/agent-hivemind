import { requireGroupId } from '@/domain/ids.ts';
import { isSessionLife } from '@/domain/model.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { jobLocks } from '@/storage/postgres/job-locks.ts';
import { readBoolean } from '@/storage/postgres/session-read.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import { many, one, readString, unreadable } from '@/storage/postgres/store-query.ts';

export function groupRetention(
  sql: Sql
): Pick<UnitOfWork, 'groupsClosedBefore' | 'removeClosedGroup'> {
  return {
    async groupsClosedBefore(closedBefore) {
      // A blocked group stays closed, so it is left out of this list. Otherwise it stays at the
      // front of every run and can use the deadline before a later group is reached.
      const rows = await many(
        sql,
        `SELECT id FROM groups g
         WHERE g.status = 'closed'
           AND g.closed_at IS NOT NULL
           AND g.closed_at <= $1::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM sessions s
             WHERE s.group_id = g.id
               AND (
                 s.life IN ('starting', 'live', 'released')
                 OR s.final_usage_pending
                 OR s.platform_stop_pending
               )
           )
         ORDER BY g.closed_at, g.id`,
        [closedBefore]
      );

      return rows.map(row => requireGroupId(readString(row, 'id')));
    },

    async removeClosedGroup(input) {
      const held = await jobLocks(sql).holdJobLock('housekeeping', input.lockId, input.now);

      if (!held) return 'stale';

      const group = await one(
        sql,
        `SELECT (
           status = 'closed'
           AND closed_at IS NOT NULL
           AND closed_at <= $2::timestamptz
         ) AS due
         FROM groups
         WHERE id = $1
         FOR UPDATE`,
        [input.groupId, input.closedBefore]
      );

      if (group === null) return 'missing';

      await sql.query(
        `SELECT id FROM tasks
         WHERE group_id = $1
         ORDER BY parent_id NULLS FIRST, id
         FOR UPDATE`,
        [input.groupId]
      );

      // Read from the locking query. A count taken before the lock is stale under Read Committed.
      const sessions = await many(
        sql,
        `SELECT life, final_usage_pending, platform_stop_pending
         FROM sessions
         WHERE group_id = $1
         ORDER BY id
         FOR UPDATE`,
        [input.groupId]
      );

      if (!readBoolean(group, 'due') || sessions.some(sessionBlocksRemoval)) return 'kept';

      await sql.query(`SELECT set_config('hivemind.retention', 'on', true)`);
      await deleteGroup(sql, input.groupId);

      return 'removed';
    },
  };
}

function sessionBlocksRemoval(row: Row): boolean {
  const life = readString(row, 'life');

  if (!isSessionLife(life)) throw unreadable();

  switch (life) {
    case 'starting':
    case 'live':
    case 'released':
      return true;
    case 'ended':
    case 'start_failed':
      return readBoolean(row, 'final_usage_pending') || readBoolean(row, 'platform_stop_pending');
    default: {
      const unexpected: never = life;

      return unexpected;
    }
  }
}

async function deleteGroup(sql: Sql, groupId: string): Promise<void> {
  const targets = [groupId];

  await sql.query(
    `DELETE FROM alert_deliveries
     WHERE alert_id IN (
       SELECT id FROM alerts
       WHERE group_id = $1
          OR target_id = $1
          OR target_id IN (SELECT id FROM tasks WHERE group_id = $1)
          OR target_id IN (SELECT id FROM sessions WHERE group_id = $1)
     )`,
    targets
  );
  await sql.query(
    `DELETE FROM alerts
     WHERE group_id = $1
        OR target_id = $1
        OR target_id IN (SELECT id FROM tasks WHERE group_id = $1)
        OR target_id IN (SELECT id FROM sessions WHERE group_id = $1)`,
    targets
  );
  await sql.query(
    `DELETE FROM planned_actions
     WHERE target_id = $1
        OR target_id IN (SELECT id FROM tasks WHERE group_id = $1)
        OR target_id IN (SELECT id FROM sessions WHERE group_id = $1)`,
    targets
  );
  await sql.query(
    `DELETE FROM waits
     WHERE group_id = $1
        OR waiting_session_id IN (SELECT id FROM sessions WHERE group_id = $1)
        OR awaited_session_id IN (SELECT id FROM sessions WHERE group_id = $1)
        OR question_id IN (SELECT id FROM messages WHERE group_id = $1)`,
    targets
  );
  await sql.query(
    `DELETE FROM outbox_copies
     WHERE group_id = $1
        OR recipient_id IN (SELECT id FROM sessions WHERE group_id = $1)
        OR message_id IN (SELECT id FROM messages WHERE group_id = $1)`,
    targets
  );
  await sql.query(
    `DELETE FROM enrollment_codes
     WHERE session_id IN (SELECT id FROM sessions WHERE group_id = $1)`,
    targets
  );
  await sql.query(
    `DELETE FROM session_job_state
     WHERE session_id IN (SELECT id FROM sessions WHERE group_id = $1)`,
    targets
  );
  await sql.query('DELETE FROM spawn_log WHERE group_id = $1', targets);
  await sql.query('DELETE FROM messages WHERE group_id = $1', targets);
  await sql.query('DELETE FROM sessions WHERE group_id = $1', targets);
  await sql.query('DELETE FROM task_events WHERE group_id = $1', targets);
  await deleteTasks(sql, groupId);
  await sql.query('DELETE FROM context_notes WHERE group_id = $1', targets);
  await sql.query('DELETE FROM groups WHERE id = $1', targets);
}

async function deleteTasks(sql: Sql, groupId: string): Promise<void> {
  for (;;) {
    const deleted = await sql.query(
      `DELETE FROM tasks
       WHERE group_id = $1
         AND NOT EXISTS (SELECT 1 FROM tasks AS child WHERE child.parent_id = tasks.id)
       RETURNING id`,
      [groupId]
    );

    if (deleted.rows.length === 0) return;
  }
}
