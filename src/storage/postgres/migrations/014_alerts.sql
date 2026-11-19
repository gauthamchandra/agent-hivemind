ALTER TABLE session_job_state
  ADD COLUMN bad_status_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN status_since_at timestamptz,
  ADD COLUMN usage_grew_at timestamptz;
--> statement-breakpoint
ALTER TABLE session_job_state
  ADD CONSTRAINT session_job_state_bad_status_streak_check CHECK (bad_status_streak >= 0) NOT VALID;
--> statement-breakpoint
CREATE INDEX session_job_state_orphan_ended ON session_job_state (session_id) WHERE orphan_ended;
--> statement-breakpoint
CREATE TABLE alerts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text,
  rule text NOT NULL,
  target_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('normal', 'critical')),
  reason text,
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  cleared_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX alerts_one_open
  ON alerts (rule, target_id)
  WHERE cleared_at IS NULL;
--> statement-breakpoint
COMMENT ON TABLE alerts IS 'A condition a person must see. The key is the rule and the target, and one row per key is open at a time.';
