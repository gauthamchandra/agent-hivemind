CREATE TABLE leases (
  job text PRIMARY KEY CHECK (job IN ('fleet_check', 'reaper', 'housekeeping')),
  holder text NOT NULL,
  expires_at timestamptz NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 1),
  last_started_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE job_intents (
  id text PRIMARY KEY,
  job text NOT NULL CHECK (job IN ('fleet_check', 'reaper', 'housekeeping')),
  action text NOT NULL,
  target_id text NOT NULL,
  workspace_id text NOT NULL,
  epoch bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'done')),
  created_at timestamptz NOT NULL,
  finished_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX job_intents_one_open
  ON job_intents (job, action, target_id)
  WHERE state = 'open';
--> statement-breakpoint
CREATE TABLE session_watches (
  session_id text PRIMARY KEY REFERENCES sessions (id),
  workspace_id text NOT NULL,
  bad_status_streak integer NOT NULL DEFAULT 0 CHECK (bad_status_streak >= 0),
  unknown_streak integer NOT NULL DEFAULT 0 CHECK (unknown_streak >= 0),
  end_unconfirmed_runs integer NOT NULL DEFAULT 0 CHECK (end_unconfirmed_runs >= 0),
  end_attempt_runs integer NOT NULL DEFAULT 0 CHECK (end_attempt_runs >= 0),
  inconclusive_runs integer NOT NULL DEFAULT 0 CHECK (inconclusive_runs >= 0),
  last_find text CHECK (
    last_find IS NULL OR last_find IN ('found', 'absent', 'inconclusive')
  ),
  status_since_at timestamptz,
  last_reading_at timestamptz,
  suspended_at timestamptz,
  suspended_progress_at timestamptz,
  last_observed_at timestamptz,
  orphan_ended boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE connection_watches (
  connection_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  auth_fail_streak integer NOT NULL DEFAULT 0 CHECK (auth_fail_streak >= 0),
  probe_failed boolean NOT NULL DEFAULT false,
  last_probe_at timestamptz
);
--> statement-breakpoint
CREATE TABLE findings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text,
  rule text NOT NULL,
  target_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('normal', 'critical')),
  reason text,
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  notified_at timestamptz,
  acknowledged_at timestamptz,
  cleared_at timestamptz,
  notify boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX findings_one_open
  ON findings (rule, target_id)
  WHERE cleared_at IS NULL;
--> statement-breakpoint
CREATE TABLE notification_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  delivery_id text NOT NULL,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('owner', 'administrator')),
  recipient_id text NOT NULL,
  finding_ids jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'sent', 'failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE retention_grants (
  group_id text PRIMARY KEY,
  workspace_id text NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM retention_grants WHERE group_id = OLD.group_id
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'task events are append-only';
END;
$fn$;
