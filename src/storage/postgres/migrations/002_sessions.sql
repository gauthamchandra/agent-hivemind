ALTER TABLE workspaces
  ADD COLUMN live_sessions integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_live_sessions_check CHECK (live_sessions >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE groups
  ADD COLUMN live_sessions integer NOT NULL DEFAULT 0,
  ADD COLUMN live_planner integer NOT NULL DEFAULT 0,
  ADD COLUMN live_challenger integer NOT NULL DEFAULT 0,
  ADD COLUMN live_implementer integer NOT NULL DEFAULT 0,
  ADD COLUMN total_sessions integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE groups
  ADD CONSTRAINT groups_live_sessions_check CHECK (live_sessions >= 0) NOT VALID,
  ADD CONSTRAINT groups_live_planner_check CHECK (live_planner >= 0) NOT VALID,
  ADD CONSTRAINT groups_live_challenger_check CHECK (live_challenger >= 0) NOT VALID,
  ADD CONSTRAINT groups_live_implementer_check CHECK (live_implementer >= 0) NOT VALID,
  ADD CONSTRAINT groups_total_sessions_check CHECK (total_sessions >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE task_events DROP CONSTRAINT task_events_kind_check;
--> statement-breakpoint
ALTER TABLE task_events ADD CONSTRAINT task_events_kind_check CHECK (
  kind IN (
    'created',
    'transition',
    'verification_mode_changed',
    'owner_instruction',
    'note',
    'session_started',
    'session_start_failed',
    'session_ended'
  )
) NOT VALID;
--> statement-breakpoint
CREATE TABLE sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  task_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('planner', 'challenger', 'implementer', 'reviewer', 'verifier')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  parent_session_id text,
  platform_session_ref text,
  platform_address text,
  title text NOT NULL,
  life text NOT NULL CHECK (life IN ('starting', 'live', 'released', 'ended', 'start_failed')),
  token_hash text UNIQUE,
  enrolled_at timestamptz,
  enrolled_by text CHECK (enrolled_by IS NULL OR enrolled_by IN ('secret', 'code')),
  last_report_at timestamptz,
  start_attempt_id text NOT NULL,
  existence_evidence_at timestamptz,
  end_requested_at timestamptz,
  end_actor_kind text CHECK (end_actor_kind IS NULL OR end_actor_kind IN ('session', 'person', 'service')),
  end_actor_id text,
  end_reason text,
  end_operation_id text,
  final_usage_pending boolean NOT NULL DEFAULT false,
  last_status text,
  usage numeric,
  attributed_to text CHECK (attributed_to IS NULL OR attributed_to IN ('owner', 'service')),
  secret_delivered text CHECK (secret_delivered IS NULL OR secret_delivered IN ('yes', 'no', 'unknown')),
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_one_holder
  ON sessions (task_id, role)
  WHERE life IN ('starting', 'live', 'released') AND role <> 'challenger';
--> statement-breakpoint
CREATE TABLE enrollment_codes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  voided_at timestamptz,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id)
);
--> statement-breakpoint
CREATE TABLE spawn_log (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  session_id text NOT NULL,
  at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id)
);
--> statement-breakpoint
CREATE INDEX spawn_log_group_at ON spawn_log (group_id, at);
--> statement-breakpoint
CREATE TABLE idempotency_keys (
  workspace_id text NOT NULL,
  caller_kind text NOT NULL,
  caller_id text NOT NULL,
  route text NOT NULL,
  idempotency_key text NOT NULL,
  body_hash text NOT NULL,
  record_id text,
  response jsonb,
  completed boolean NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, caller_kind, caller_id, route, idempotency_key)
);
--> statement-breakpoint
ALTER TABLE groups DROP CONSTRAINT groups_check;
