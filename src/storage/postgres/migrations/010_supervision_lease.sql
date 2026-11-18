CREATE TABLE leases (
  job text PRIMARY KEY CHECK (job IN ('fleet_check', 'reaper', 'housekeeping')),
  holder text NOT NULL,
  expires_at timestamptz NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 1),
  last_started_at timestamptz NOT NULL
);
--> statement-breakpoint
COMMENT ON TABLE leases IS 'One row per supervision job: the holder, when its lease expires, and the epoch that fences a stale holder.';
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
COMMENT ON TABLE job_intents IS 'An action a supervision job committed before it called a platform, so the next lease holder finishes it instead of recording a second one.';
--> statement-breakpoint
CREATE TABLE session_watches (
  session_id text PRIMARY KEY REFERENCES sessions (id),
  workspace_id text NOT NULL,
  unknown_streak integer NOT NULL DEFAULT 0 CHECK (unknown_streak >= 0),
  end_unconfirmed_runs integer NOT NULL DEFAULT 0 CHECK (end_unconfirmed_runs >= 0),
  end_attempt_runs integer NOT NULL DEFAULT 0 CHECK (end_attempt_runs >= 0),
  inconclusive_runs integer NOT NULL DEFAULT 0 CHECK (inconclusive_runs >= 0),
  last_find text CHECK (
    last_find IS NULL OR last_find IN ('found', 'absent', 'inconclusive')
  ),
  suspended_at timestamptz,
  suspended_progress_at timestamptz,
  orphan_ended boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
COMMENT ON TABLE session_watches IS 'What supervision remembers about one session between ticks.';
