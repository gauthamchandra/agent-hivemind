import { requireGroupId, requireWorkspaceId } from '@/domain/ids.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { many, readString } from '@/storage/postgres/store-query.ts';

export function supervisionHousekeeping(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'deleteExpiredCodes'
  | 'deleteOldRateRows'
  | 'deleteOldSpawns'
  | 'groupsClosedBefore'
  | 'retainGroup'
  | 'correctCounters'
> {
  return {
    async deleteExpiredCodes(now) {
      await sql.query(
        `DELETE FROM enrollment_codes
         WHERE (expires_at IS NOT NULL AND expires_at <= $1::timestamptz)
            OR (voided_at IS NOT NULL AND voided_at <= $1::timestamptz)`,
        [now]
      );
    },

    async deleteOldRateRows(before) {
      await sql.query(
        'DELETE FROM connection_rate_windows WHERE window_start_at <= $1::timestamptz',
        [before]
      );
    },

    async deleteOldSpawns(before) {
      await sql.query('DELETE FROM spawn_log WHERE at <= $1::timestamptz', [before]);
    },

    async groupsClosedBefore(instant) {
      const rows = await many(
        sql,
        `SELECT workspace_id, id FROM groups
         WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at <= $1::timestamptz`,
        [instant]
      );

      return rows.map(row => ({
        workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
        id: requireGroupId(readString(row, 'id')),
      }));
    },

    async retainGroup(workspaceId, groupId) {
      await removeClosedGroup(sql, workspaceId, groupId);
    },

    async correctCounters() {
      const groups = await many(
        sql,
        `WITH counted AS (
           SELECT g.id,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live')) AS live,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live') AND s.role = 'planner') AS planner,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live') AND s.role = 'challenger') AS challenger,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live') AND s.role = 'implementer') AS implementer,
             (SELECT count(*)::int FROM sessions s WHERE s.group_id = g.id) AS total
           FROM groups g
         )
         UPDATE groups g
         SET live_sessions = c.live,
             live_planner = c.planner,
             live_challenger = c.challenger,
             live_implementer = c.implementer,
             total_sessions = c.total
         FROM counted c
         WHERE g.id = c.id
           AND (g.live_sessions IS DISTINCT FROM c.live
             OR g.live_planner IS DISTINCT FROM c.planner
             OR g.live_challenger IS DISTINCT FROM c.challenger
             OR g.live_implementer IS DISTINCT FROM c.implementer
             OR g.total_sessions IS DISTINCT FROM c.total)
         RETURNING g.id`,
        []
      );

      await sql.query(
        `WITH counted AS (
           SELECT w.id,
             (SELECT count(*)::int FROM sessions s
              WHERE s.workspace_id = w.id AND s.life IN ('starting', 'live')) AS live
           FROM workspaces w
         )
         UPDATE workspaces w
         SET live_sessions = c.live
         FROM counted c
         WHERE w.id = c.id AND w.live_sessions IS DISTINCT FROM c.live`,
        []
      );

      return groups.map(row => readString(row, 'id'));
    },
  };
}

async function removeClosedGroup(sql: Sql, workspaceId: string, groupId: string) {
  const ids = await many(
    sql,
    `SELECT id FROM sessions WHERE workspace_id = $1 AND group_id = $2
         UNION ALL
         SELECT id FROM tasks WHERE workspace_id = $1 AND group_id = $2
         UNION ALL
         SELECT $2`,
    [workspaceId, groupId]
  );
  const recordIds = ids.map(row => readString(row, 'id'));

  await sql.query(
    'INSERT INTO retention_grants (group_id, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [groupId, workspaceId]
  );
  await sql.query('DELETE FROM outbox_copies WHERE group_id = $1', [groupId]);
  await sql.query('DELETE FROM waits WHERE group_id = $1', [groupId]);
  await sql.query(
    `DELETE FROM notification_attempts AS attempt
         WHERE attempt.workspace_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(attempt.finding_ids) AS finding_id(id)
             JOIN findings ON findings.id = finding_id.id
             WHERE findings.group_id IS DISTINCT FROM $2
           )`,
    [workspaceId, groupId]
  );
  await sql.query('DELETE FROM findings WHERE group_id = $1', [groupId]);
  await sql.query(
    `DELETE FROM job_intents WHERE workspace_id = $1 AND target_id = ANY($2::text[])`,
    [workspaceId, recordIds]
  );
  await sql.query(
    `DELETE FROM session_watches WHERE session_id IN (
           SELECT id FROM sessions WHERE workspace_id = $1 AND group_id = $2
         )`,
    [workspaceId, groupId]
  );
  await sql.query(
    `DELETE FROM enrollment_codes WHERE session_id IN (
           SELECT id FROM sessions WHERE workspace_id = $1 AND group_id = $2
         )`,
    [workspaceId, groupId]
  );
  await sql.query('DELETE FROM spawn_log WHERE workspace_id = $1 AND group_id = $2', [
    workspaceId,
    groupId,
  ]);
  await sql.query(
    `DELETE FROM idempotency_keys
         WHERE workspace_id = $1 AND (record_id = ANY($2::text[]) OR caller_id = ANY($2::text[]))`,
    [workspaceId, recordIds]
  );
  await sql.query('DELETE FROM messages WHERE workspace_id = $1 AND group_id = $2', [
    workspaceId,
    groupId,
  ]);
  await sql.query('DELETE FROM sessions WHERE workspace_id = $1 AND group_id = $2', [
    workspaceId,
    groupId,
  ]);
  await sql.query('DELETE FROM task_events WHERE workspace_id = $1 AND group_id = $2', [
    workspaceId,
    groupId,
  ]);
  await sql.query('DELETE FROM context_notes WHERE workspace_id = $1 AND group_id = $2', [
    workspaceId,
    groupId,
  ]);
  await sql.query(
    'DELETE FROM tasks WHERE workspace_id = $1 AND group_id = $2 AND parent_id IS NOT NULL',
    [workspaceId, groupId]
  );
  await sql.query('DELETE FROM tasks WHERE workspace_id = $1 AND group_id = $2', [
    workspaceId,
    groupId,
  ]);
  await sql.query('DELETE FROM retention_grants WHERE group_id = $1', [groupId]);
  await sql.query('DELETE FROM groups WHERE workspace_id = $1 AND id = $2', [workspaceId, groupId]);
}
