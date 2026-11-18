import type { NotificationAttempt } from '@/domain/supervision.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { parseWait } from '@/storage/postgres/message-rows.ts';
import { parseGroup } from '@/storage/postgres/parse-group.ts';
import { parseTask } from '@/storage/postgres/parse-task.ts';
import { parseSession } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import {
  many,
  one,
  readNullableTime,
  readNumber,
  readString,
} from '@/storage/postgres/store-query.ts';
import {
  findingParams,
  fleetSnapshot,
  parseAttempt,
  parseConnection,
  parseConnectionWatch,
  parseFinding,
  parseWatch,
  watchParams,
} from '@/storage/postgres/supervision-parse.ts';

type FleetWork = Pick<
  UnitOfWork,
  | 'saveWatch'
  | 'saveConnectionWatch'
  | 'loadFleet'
  | 'listFindings'
  | 'openFindingByKey'
  | 'insertFinding'
  | 'touchFinding'
  | 'clearFinding'
  | 'acknowledgeFinding'
  | 'markFindingNotify'
  | 'noteNotified'
  | 'updateFindingReason'
  | 'countEscalations'
  | 'insertAttempt'
  | 'finishAttempt'
>;

export function supervisionFleet(sql: Sql): FleetWork {
  return {
    async saveWatch(watch) {
      await sql.query(
        `INSERT INTO session_watches (
           session_id, workspace_id, bad_status_streak, unknown_streak, end_unconfirmed_runs,
           end_attempt_runs, inconclusive_runs, last_find, status_since_at, last_reading_at,
           suspended_at, suspended_progress_at, last_observed_at, orphan_ended
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz,
           $11::timestamptz, $12::timestamptz, $13::timestamptz, $14
         )
         ON CONFLICT (session_id) DO UPDATE SET
           bad_status_streak = EXCLUDED.bad_status_streak,
           unknown_streak = EXCLUDED.unknown_streak,
           end_unconfirmed_runs = EXCLUDED.end_unconfirmed_runs,
           end_attempt_runs = EXCLUDED.end_attempt_runs,
           inconclusive_runs = EXCLUDED.inconclusive_runs,
           last_find = EXCLUDED.last_find,
           status_since_at = EXCLUDED.status_since_at,
           last_reading_at = EXCLUDED.last_reading_at,
           suspended_at = EXCLUDED.suspended_at,
           suspended_progress_at = EXCLUDED.suspended_progress_at,
           last_observed_at = EXCLUDED.last_observed_at,
           orphan_ended = EXCLUDED.orphan_ended`,
        watchParams(watch)
      );
    },

    async saveConnectionWatch(watch) {
      await sql.query(
        `INSERT INTO connection_watches (
           connection_id, workspace_id, auth_fail_streak, probe_failed, last_probe_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (connection_id) DO UPDATE SET
           auth_fail_streak = EXCLUDED.auth_fail_streak,
           probe_failed = EXCLUDED.probe_failed,
           last_probe_at = EXCLUDED.last_probe_at`,
        [
          watch.connectionId,
          watch.workspaceId,
          watch.authFailStreak,
          watch.probeFailed,
          watch.lastProbeAt,
        ]
      );
    },

    loadFleet() {
      return readFleet(sql);
    },

    listFindings(workspaceId) {
      return many(sql, 'SELECT * FROM findings WHERE workspace_id = $1 ORDER BY opened_at, id', [
        workspaceId,
      ]).then(rows => rows.map(parseFinding));
    },

    async openFindingByKey(rule, targetId) {
      const row = await one(
        sql,
        `SELECT * FROM findings
         WHERE rule = $1 AND target_id = $2 AND cleared_at IS NULL`,
        [rule, targetId]
      );

      return row === null ? null : parseFinding(row);
    },

    async insertFinding(finding) {
      await sql.query(
        `INSERT INTO findings (
           id, workspace_id, group_id, rule, target_id, severity, reason, opened_at,
           last_seen_at, notified_at, acknowledged_at, cleared_at, notify
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz,
           $10::timestamptz, $11::timestamptz, $12::timestamptz, $13
         )`,
        findingParams(finding)
      );
    },

    async touchFinding(id, now) {
      await sql.query('UPDATE findings SET last_seen_at = $2::timestamptz WHERE id = $1', [
        id,
        now,
      ]);
    },

    async clearFinding(id, now) {
      await sql.query(
        `UPDATE findings
         SET cleared_at = $2::timestamptz, last_seen_at = $2::timestamptz, notify = false
         WHERE id = $1 AND cleared_at IS NULL`,
        [id, now]
      );
    },

    async acknowledgeFinding(id, now, clear) {
      const row = await one(
        sql,
        `UPDATE findings
         SET acknowledged_at = $2::timestamptz,
             cleared_at = CASE WHEN $3 THEN $2::timestamptz ELSE cleared_at END,
             notify = CASE WHEN $3 THEN false ELSE notify END
         WHERE id = $1
         RETURNING *`,
        [id, now, clear]
      );

      return row === null ? null : parseFinding(row);
    },

    async markFindingNotify(id) {
      await sql.query(
        'UPDATE findings SET notify = true WHERE id = $1 AND acknowledged_at IS NULL',
        [id]
      );
    },

    async noteNotified(id, now) {
      await sql.query(
        `UPDATE findings
         SET notified_at = $2::timestamptz, notify = false, last_seen_at = $2::timestamptz
         WHERE id = $1`,
        [id, now]
      );
    },

    async updateFindingReason(id, reason, now) {
      await sql.query(
        'UPDATE findings SET reason = $2, last_seen_at = $3::timestamptz WHERE id = $1',
        [id, reason, now]
      );
    },

    countEscalations(groupId, since) {
      return many(
        sql,
        `SELECT count(*)::int AS count FROM findings
         WHERE group_id = $1 AND rule = 'escalation' AND opened_at >= $2::timestamptz`,
        [groupId, since]
      ).then(rows => readNumber(rows[0] ?? {}, 'count'));
    },

    insertAttempt(attempt) {
      return writeAttempt(sql, attempt);
    },

    finishAttempt(id, state, now) {
      return closeAttempt(sql, id, state, now);
    },
  };
}

async function readFleet(sql: Sql) {
  const groups = (await many(sql, 'SELECT * FROM groups', [])).map(parseGroup);
  const tasks = (await many(sql, 'SELECT * FROM tasks', [])).map(parseTask);
  const sessions = (
    await many(
      sql,
      `SELECT * FROM sessions
           WHERE life IN ('starting', 'live', 'released', 'start_failed')
              OR final_usage_pending
              OR (life = 'ended' AND COALESCE(last_status, '') NOT IN ('stopped', 'failed'))
           ORDER BY created_at, id`,
      []
    )
  ).map(parseSession);
  const waits = (await many(sql, 'SELECT * FROM waits WHERE cleared_at IS NULL', [])).map(
    parseWait
  );
  const watches = (await many(sql, 'SELECT * FROM session_watches', [])).map(parseWatch);
  const connectionWatches = (await many(sql, 'SELECT * FROM connection_watches', [])).map(
    parseConnectionWatch
  );
  const connections = (await many(sql, 'SELECT workspace_id, id FROM connections', [])).map(
    parseConnection
  );
  const oldestQueuedAt = await many(
    sql,
    `SELECT connection_id, min(created_at) AS at
         FROM outbox_copies WHERE state = 'queued'
         GROUP BY connection_id`,
    []
  );
  const taskActivityAt = await many(
    sql,
    `SELECT task_id, max(at) AS at FROM (
           SELECT task_id, at FROM task_events
           UNION ALL
           SELECT sender_task_id AS task_id, created_at AS at FROM messages
         ) activity GROUP BY task_id`,
    []
  );
  const relayed = await many(
    sql,
    `SELECT DISTINCT sender_id FROM messages WHERE kind = 'relayed_instruction'`,
    []
  );
  const unusedCodes = await many(
    sql,
    `SELECT session_id, expires_at FROM enrollment_codes
         WHERE used_at IS NULL AND voided_at IS NULL AND expires_at IS NOT NULL`,
    []
  );
  const findings = (await many(sql, 'SELECT * FROM findings', [])).map(parseFinding);
  const attempts = (await many(sql, 'SELECT * FROM notification_attempts', [])).map(parseAttempt);

  return fleetSnapshot({
    groups,
    tasks,
    sessions,
    waits,
    watches,
    connectionWatches,
    connections,
    oldestQueuedAt,
    taskActivityAt,
    relayed,
    unusedCodeExpires: unusedCodes.map(row => ({
      sessionId: readString(row, 'session_id'),
      expiresAt: readNullableTime(row.expires_at) ?? '',
    })),
    findings,
    attempts,
  });
}

async function writeAttempt(sql: Sql, attempt: NotificationAttempt): Promise<void> {
  await sql.query(
    `INSERT INTO notification_attempts (
       id, workspace_id, delivery_id, recipient_kind, recipient_id, finding_ids,
       state, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)`,
    [
      attempt.id,
      attempt.workspaceId,
      attempt.deliveryId,
      attempt.recipientKind,
      attempt.recipientId,
      JSON.stringify(attempt.findingIds),
      attempt.state,
      attempt.createdAt,
      attempt.updatedAt,
    ]
  );
}

async function closeAttempt(
  sql: Sql,
  id: string,
  state: 'sent' | 'failed',
  now: string
): Promise<void> {
  await sql.query(
    `UPDATE notification_attempts
     SET state = $2, updated_at = $3::timestamptz WHERE id = $1`,
    [id, state, now]
  );
}
