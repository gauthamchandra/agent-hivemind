ALTER TABLE leases RENAME TO job_locks;
--> statement-breakpoint
ALTER TABLE job_locks RENAME COLUMN holder TO locked_by;
--> statement-breakpoint
ALTER TABLE job_locks RENAME COLUMN epoch TO lock_id;
--> statement-breakpoint
ALTER TABLE job_locks RENAME CONSTRAINT leases_pkey TO job_locks_pkey;
--> statement-breakpoint
ALTER TABLE job_locks RENAME CONSTRAINT leases_epoch_check TO job_locks_lock_id_check;
--> statement-breakpoint
ALTER TABLE job_locks DROP CONSTRAINT leases_job_check;
--> statement-breakpoint
ALTER TABLE job_locks
  ADD CONSTRAINT job_locks_job_check
  CHECK (job IN ('usage_poll', 'reaper', 'housekeeping')) NOT VALID;
--> statement-breakpoint
COMMENT ON TABLE job_locks IS 'One row per background job: the worker that holds its lock, when the lock expires, and the lock id that keeps a worker that lost the lock from writing.';
--> statement-breakpoint
ALTER TABLE job_intents RENAME TO planned_actions;
--> statement-breakpoint
ALTER TABLE planned_actions RENAME COLUMN epoch TO lock_id;
--> statement-breakpoint
ALTER TABLE planned_actions RENAME CONSTRAINT job_intents_pkey TO planned_actions_pkey;
--> statement-breakpoint
ALTER TABLE planned_actions
  RENAME CONSTRAINT job_intents_state_check TO planned_actions_state_check;
--> statement-breakpoint
ALTER TABLE planned_actions DROP CONSTRAINT job_intents_job_check;
--> statement-breakpoint
ALTER TABLE planned_actions
  ADD CONSTRAINT planned_actions_job_check
  CHECK (job IN ('usage_poll', 'reaper', 'housekeeping')) NOT VALID;
--> statement-breakpoint
ALTER INDEX job_intents_one_open RENAME TO planned_actions_one_open;
--> statement-breakpoint
COMMENT ON TABLE planned_actions IS 'An action a background job recorded before it called a platform, so the next worker that takes the lock finishes it instead of recording a second one.';
--> statement-breakpoint
ALTER TABLE session_watches RENAME TO session_job_state;
--> statement-breakpoint
ALTER TABLE session_job_state RENAME CONSTRAINT session_watches_pkey TO session_job_state_pkey;
--> statement-breakpoint
ALTER TABLE session_job_state
  RENAME CONSTRAINT session_watches_session_id_fkey TO session_job_state_session_id_fkey;
--> statement-breakpoint
ALTER TABLE session_job_state
  RENAME CONSTRAINT session_watches_end_attempt_runs_check TO session_job_state_end_attempt_runs_check;
--> statement-breakpoint
ALTER TABLE session_job_state
  RENAME CONSTRAINT session_watches_end_unconfirmed_runs_check TO session_job_state_end_unconfirmed_runs_check;
--> statement-breakpoint
ALTER TABLE session_job_state
  RENAME CONSTRAINT session_watches_inconclusive_runs_check TO session_job_state_inconclusive_runs_check;
--> statement-breakpoint
ALTER TABLE session_job_state
  RENAME CONSTRAINT session_watches_last_find_check TO session_job_state_last_find_check;
--> statement-breakpoint
ALTER TABLE session_job_state
  RENAME CONSTRAINT session_watches_unknown_streak_check TO session_job_state_unknown_streak_check;
--> statement-breakpoint
COMMENT ON TABLE session_job_state IS 'What the background jobs remember about one session between runs.';
--> statement-breakpoint
DO $rename$
DECLARE
  not_null record;
BEGIN
  FOR not_null IN
    SELECT c.conrelid::regclass::text AS table_name, c.conname, a.attname AS column_name
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'n'
      AND c.conrelid::regclass::text IN ('job_locks', 'planned_actions', 'session_job_state')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
      not_null.table_name,
      not_null.conname,
      not_null.table_name || '_' || not_null.column_name || '_not_null'
    );
  END LOOP;
END
$rename$;
