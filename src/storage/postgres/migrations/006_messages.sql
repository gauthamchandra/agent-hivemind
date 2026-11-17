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
    'session_ended',
    'message',
    'message_dropped'
  )
) NOT VALID;
--> statement-breakpoint
CREATE TABLE messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  sender_kind text NOT NULL CHECK (sender_kind IN ('session', 'person')),
  sender_id text NOT NULL,
  sender_role text NOT NULL,
  sender_task_id text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('note', 'question', 'answer', 'instruction', 'relayed_instruction')
  ),
  audience text NOT NULL CHECK (audience IN ('one', 'all', 'none')),
  in_reply_to text,
  body text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, sender_id, idempotency_key),
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id)
);
--> statement-breakpoint
CREATE INDEX messages_sender_created ON messages (sender_id, created_at);
--> statement-breakpoint
CREATE TABLE outbox_copies (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  connection_id text NOT NULL,
  message_id text NOT NULL REFERENCES messages (id),
  recipient_id text NOT NULL REFERENCES sessions (id),
  sequence bigint NOT NULL,
  claim_generation integer NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'dropped')),
  attempts integer NOT NULL DEFAULT 0,
  busy_streak integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  claimed_by text,
  claimed_until timestamptz,
  outcome_reason text CHECK (
    outcome_reason IS NULL OR outcome_reason IN (
      'recipient_ended',
      'recipient_unknown_to_platform',
      'platform_rejected',
      'expired',
      'recipient_start_failed'
    )
  ),
  platform_reference text,
  created_at timestamptz NOT NULL,
  delivered_at timestamptz,
  UNIQUE (recipient_id, sequence)
);
--> statement-breakpoint
CREATE INDEX outbox_copies_recipient_state ON outbox_copies (recipient_id, state, sequence);
--> statement-breakpoint
CREATE TABLE waits (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  waiting_session_id text NOT NULL REFERENCES sessions (id),
  awaited_session_id text NOT NULL REFERENCES sessions (id),
  question_id text REFERENCES messages (id),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  cleared_at timestamptz,
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id)
);
--> statement-breakpoint
CREATE TABLE connection_rate_windows (
  connection_id text NOT NULL,
  window_start_at timestamptz NOT NULL,
  message_calls integer NOT NULL CHECK (message_calls >= 0),
  PRIMARY KEY (connection_id, window_start_at)
);
--> statement-breakpoint
CREATE TABLE connection_send_pauses (
  connection_id text PRIMARY KEY,
  paused_until timestamptz NOT NULL
);
