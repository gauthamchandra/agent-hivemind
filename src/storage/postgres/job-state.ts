import type { AlertRecord, JobSnapshot } from '@/domain/background-jobs.ts';
import { alertRules, reminderCriticalMs, reminderNormalMs } from '@/domain/background-jobs.ts';
import { formatTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import {
  alertParams,
  jobSnapshotExtras,
  parseAlert,
  parseSessionJobState,
  sessionJobStateParams,
} from '@/storage/postgres/job-parse.ts';
import { parseWait } from '@/storage/postgres/message-rows.ts';
import { parseGroup } from '@/storage/postgres/parse-group.ts';
import { parseTask } from '@/storage/postgres/parse-task.ts';
import { parseSession } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { count, many, one, readNullableTime, readString } from '@/storage/postgres/store-query.ts';

const usagePollColumns =
  'bad_status_streak = EXCLUDED.bad_status_streak, status_since_at = EXCLUDED.status_since_at, last_reading_at = EXCLUDED.last_reading_at, last_attempt_at = EXCLUDED.last_attempt_at, usage_grew_at = EXCLUDED.usage_grew_at';

const reaperColumns =
  'end_unconfirmed_runs = EXCLUDED.end_unconfirmed_runs, end_attempt_runs = EXCLUDED.end_attempt_runs, inconclusive_runs = EXCLUDED.inconclusive_runs, last_find = EXCLUDED.last_find, suspended_at = EXCLUDED.suspended_at, suspended_progress_at = EXCLUDED.suspended_progress_at, orphan_ended = EXCLUDED.orphan_ended';

// A newer release may open an alert of a rule this release does not know. Reading such a row
// would fail every run, so the snapshot leaves it for the release that owns it.
const knownAlertRules = alertRules.map(rule => `'${rule}'`).join(', ');

const unsettledSessionsCondition = `life IN ('starting', 'live', 'released')
  OR (life = 'start_failed' AND platform_session_ref IS NULL)
  OR final_usage_pending
  OR platform_stop_pending
  OR (
    life = 'ended'
    AND platform_session_ref IS NOT NULL
    AND COALESCE(last_status, '') NOT IN ('stopped', 'failed')
  )`;

export function jobState(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'saveSessionJobState'
  | 'loadJobSnapshot'
  | 'openAlertByKey'
  | 'insertAlert'
  | 'touchAlert'
  | 'clearAlert'
  | 'updateAlertReason'
  | 'countEscalations'
  | 'openAlerts'
  | 'openAlertIds'
> {
  return {
    async saveSessionJobState(jobState, scope) {
      await sql.query(
        `INSERT INTO session_job_state (
           session_id, workspace_id, bad_status_streak, unknown_streak, end_unconfirmed_runs,
           end_attempt_runs, inconclusive_runs, last_find, status_since_at, suspended_at,
           suspended_progress_at, last_reading_at, last_attempt_at, usage_grew_at, orphan_ended
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz,
           $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::timestamptz, $15
         )
         ON CONFLICT (session_id) DO UPDATE SET
           ${scope === 'usage_poll' ? usagePollColumns : reaperColumns}`,
        sessionJobStateParams(jobState)
      );
    },

    loadJobSnapshot() {
      return readJobSnapshot(sql);
    },

    async openAlertByKey(rule, targetId) {
      const row = await one(
        sql,
        'SELECT * FROM alerts WHERE rule = $1 AND target_id = $2 AND cleared_at IS NULL',
        [rule, targetId]
      );

      return row === null ? null : parseAlert(row);
    },

    async insertAlert(alert) {
      await insertAlertRow(sql, alert);
    },

    async touchAlert(id, now) {
      await sql.query('UPDATE alerts SET last_seen_at = $2::timestamptz WHERE id = $1', [id, now]);
    },

    async clearAlert(id, now) {
      await sql.query(
        `UPDATE alerts
         SET cleared_at = $2::timestamptz, last_seen_at = $2::timestamptz
         WHERE id = $1 AND cleared_at IS NULL`,
        [id, now]
      );
    },

    async updateAlertReason(id, reason, now) {
      await sql.query(
        'UPDATE alerts SET reason = $2, last_seen_at = $3::timestamptz WHERE id = $1',
        [id, reason, now]
      );
    },

    openAlerts() {
      return knownOpenAlerts(sql);
    },

    async openAlertIds() {
      const rows = await many(sql, 'SELECT id FROM alerts WHERE cleared_at IS NULL', []);

      return rows.map(row => readString(row, 'id'));
    },

    countEscalations(groupId, since) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM alerts
         WHERE group_id = $1 AND rule = 'escalation' AND opened_at >= $2::timestamptz`,
        [groupId, since]
      );
    },
  };
}

async function knownOpenAlerts(sql: Sql): Promise<AlertRecord[]> {
  const rows = await many(
    sql,
    `SELECT * FROM alerts WHERE cleared_at IS NULL AND rule IN (${knownAlertRules})`,
    []
  );

  return rows.map(parseAlert);
}

/**
 * A condition that clears and returns gets a new row. It inherits when the earlier rows were last
 * notified while that is younger than its reminder interval, so it is notified at most once per
 * interval, not once per return. An older notification is not inherited, so a new incident is a
 * first notification.
 */
async function insertAlertRow(sql: Sql, alert: AlertRecord): Promise<void> {
  await sql.query(
    `INSERT INTO alerts (
       id, workspace_id, group_id, rule, target_id, severity, reason, opened_at,
       last_seen_at, cleared_at, notified_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz,
       COALESCE(
         $11::timestamptz,
         (
           SELECT max(notified_at) FROM alerts
           WHERE rule = $4 AND target_id = $5 AND notified_at > $12::timestamptz
         )
       )
     )`,
    [...alertParams(alert), inheritedSince(alert)]
  );
}

function inheritedSince(alert: AlertRecord): string {
  const interval = alert.severity === 'critical' ? reminderCriticalMs : reminderNormalMs;

  return formatTime(new Date(Date.parse(alert.openedAt) - interval));
}

async function readJobSnapshot(sql: Sql): Promise<JobSnapshot> {
  const groups = (await many(sql, 'SELECT * FROM groups', [])).map(parseGroup);
  const tasks = (await many(sql, 'SELECT * FROM tasks', [])).map(parseTask);
  const sessions = (
    await many(
      sql,
      `SELECT * FROM sessions WHERE ${unsettledSessionsCondition} ORDER BY created_at, id`,
      []
    )
  ).map(parseSession);
  const waits = (await many(sql, 'SELECT * FROM waits WHERE cleared_at IS NULL', [])).map(
    parseWait
  );
  const sessionJobStates = (
    await many(
      sql,
      `SELECT * FROM session_job_state
       WHERE session_id IN (SELECT id FROM sessions WHERE ${unsettledSessionsCondition})`,
      []
    )
  ).map(parseSessionJobState);
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
           UNION ALL
           SELECT s.task_id, w.usage_grew_at AS at
           FROM session_job_state w
           JOIN sessions s ON s.id = w.session_id
           WHERE w.usage_grew_at IS NOT NULL
         ) activity GROUP BY task_id`,
    []
  );
  const relayed = await many(
    sql,
    `SELECT DISTINCT sender_id FROM messages WHERE kind = 'relayed_instruction'`,
    []
  );
  const orphanEnded = await many(
    sql,
    `SELECT j.session_id, s.group_id
         FROM session_job_state j JOIN sessions s ON s.id = j.session_id
         WHERE j.orphan_ended`,
    []
  );
  const unusedCodes = await many(
    sql,
    `SELECT session_id, expires_at FROM enrollment_codes
         WHERE used_at IS NULL AND voided_at IS NULL AND expires_at IS NOT NULL`,
    []
  );
  const alerts = await knownOpenAlerts(sql);

  return {
    groups,
    tasks,
    sessions,
    waits,
    sessionJobStates,
    ...jobSnapshotExtras({ oldestQueuedAt, taskActivityAt, relayed, orphanEnded }),
    unusedCodeExpires: unusedCodes.map(row => ({
      sessionId: readString(row, 'session_id'),
      expiresAt: readNullableTime(row.expires_at) ?? '',
    })),
    alerts,
  };
}
