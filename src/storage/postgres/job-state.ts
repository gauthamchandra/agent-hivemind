import type { UnitOfWork } from '@/ports/storage.ts';
import { parseSessionJobState, sessionJobStateParams } from '@/storage/postgres/job-parse.ts';
import { parseWait } from '@/storage/postgres/message-rows.ts';
import { parseGroup } from '@/storage/postgres/parse-group.ts';
import { parseTask } from '@/storage/postgres/parse-task.ts';
import { parseSession } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { many } from '@/storage/postgres/store-query.ts';

const usagePollColumns =
  'last_reading_at = EXCLUDED.last_reading_at, last_attempt_at = EXCLUDED.last_attempt_at';

const reaperColumns =
  'end_unconfirmed_runs = EXCLUDED.end_unconfirmed_runs, end_attempt_runs = EXCLUDED.end_attempt_runs, inconclusive_runs = EXCLUDED.inconclusive_runs, last_find = EXCLUDED.last_find, suspended_at = EXCLUDED.suspended_at, suspended_progress_at = EXCLUDED.suspended_progress_at, orphan_ended = EXCLUDED.orphan_ended';

const unsettledSessionsCondition = `life IN ('starting', 'live', 'released')
  OR (life = 'start_failed' AND platform_session_ref IS NULL)
  OR final_usage_pending
  OR platform_stop_pending
  OR (
    life = 'ended'
    AND platform_session_ref IS NOT NULL
    AND COALESCE(last_status, '') NOT IN ('stopped', 'failed')
  )`;

export function jobState(sql: Sql): Pick<UnitOfWork, 'saveSessionJobState' | 'loadJobSnapshot'> {
  return {
    async saveSessionJobState(jobState, scope) {
      await sql.query(
        `INSERT INTO session_job_state (
           session_id, workspace_id, unknown_streak, end_unconfirmed_runs, end_attempt_runs,
           inconclusive_runs, last_find, suspended_at, suspended_progress_at, last_reading_at,
           last_attempt_at, orphan_ended
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz,
           $11::timestamptz, $12
         )
         ON CONFLICT (session_id) DO UPDATE SET
           ${scope === 'usage_poll' ? usagePollColumns : reaperColumns}`,
        sessionJobStateParams(jobState)
      );
    },

    loadJobSnapshot() {
      return readJobSnapshot(sql);
    },
  };
}

async function readJobSnapshot(sql: Sql) {
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

  return { groups, tasks, sessions, waits, sessionJobStates };
}
