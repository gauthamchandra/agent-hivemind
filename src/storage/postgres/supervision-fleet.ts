import type { UnitOfWork } from '@/ports/storage.ts';
import { parseWait } from '@/storage/postgres/message-rows.ts';
import { parseGroup } from '@/storage/postgres/parse-group.ts';
import { parseTask } from '@/storage/postgres/parse-task.ts';
import { parseSession } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { many } from '@/storage/postgres/store-query.ts';
import { parseWatch, watchParams } from '@/storage/postgres/supervision-parse.ts';

export function supervisionFleet(sql: Sql): Pick<UnitOfWork, 'saveWatch' | 'loadFleet'> {
  return {
    async saveWatch(watch) {
      await sql.query(
        `INSERT INTO session_watches (
           session_id, workspace_id, unknown_streak, end_unconfirmed_runs, end_attempt_runs,
           inconclusive_runs, last_find, suspended_at, suspended_progress_at, orphan_ended
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10
         )
         ON CONFLICT (session_id) DO UPDATE SET
           end_unconfirmed_runs = EXCLUDED.end_unconfirmed_runs,
           end_attempt_runs = EXCLUDED.end_attempt_runs,
           inconclusive_runs = EXCLUDED.inconclusive_runs,
           last_find = EXCLUDED.last_find,
           suspended_at = EXCLUDED.suspended_at,
           suspended_progress_at = EXCLUDED.suspended_progress_at,
           orphan_ended = EXCLUDED.orphan_ended`,
        watchParams(watch)
      );
    },

    loadFleet() {
      return readFleet(sql);
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
              OR platform_stop_pending
           ORDER BY created_at, id`,
      []
    )
  ).map(parseSession);
  const waits = (await many(sql, 'SELECT * FROM waits WHERE cleared_at IS NULL', [])).map(
    parseWait
  );
  const watches = (await many(sql, 'SELECT * FROM session_watches', [])).map(parseWatch);

  return { groups, tasks, sessions, waits, watches };
}
