CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  limits jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE accounts (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (issuer, subject)
);
--> statement-breakpoint
CREATE TABLE people (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  display_name text NOT NULL,
  workspace_role text NOT NULL CHECK (workspace_role IN ('member', 'administrator')),
  account_id text REFERENCES accounts (id),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, account_id)
);
--> statement-breakpoint
CREATE TABLE operator_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  role text NOT NULL CHECK (role IN ('reader', 'creator', 'administrator', 'bootstrap')),
  key_hash text NOT NULL UNIQUE,
  person_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id),
  CHECK (
    (role = 'bootstrap' AND person_id IS NULL)
    OR (role <> 'bootstrap' AND person_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE groups (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  goal text NOT NULL CHECK (octet_length(goal) BETWEEN 1 AND 32768),
  owner_person_id text NOT NULL,
  default_verification_mode text NOT NULL CHECK (
    default_verification_mode IN ('before_merge', 'both', 'after_merge')
  ),
  connection_id text NOT NULL,
  budget numeric NOT NULL CHECK (budget > 0),
  spend numeric NOT NULL CHECK (spend >= 0),
  caps jsonb NOT NULL,
  session_settings jsonb NOT NULL,
  context_fingerprint text NOT NULL,
  features jsonb NOT NULL,
  initiator text,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_person_id) REFERENCES people (workspace_id, id),
  CHECK (budget >= spend)
);
--> statement-breakpoint
CREATE TABLE context_notes (
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL CHECK (char_length(name) > 0),
  body text NOT NULL CHECK (char_length(body) > 0),
  PRIMARY KEY (group_id, position),
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id)
);
--> statement-breakpoint
CREATE TABLE tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  parent_id text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (octet_length(description) BETWEEN 1 AND 32768),
  state text NOT NULL CHECK (
    state IN (
      'planned',
      'analyzing',
      'implementing',
      'in_review',
      'approved',
      'verifying_before_merge',
      'merging',
      'verifying_after_merge',
      'done',
      'failed'
    )
  ),
  state_entered_at timestamptz NOT NULL,
  verification_mode text NOT NULL CHECK (verification_mode IN ('before_merge', 'both', 'after_merge')),
  changeset_id text,
  depends_on jsonb NOT NULL,
  changeset_round integer NOT NULL CHECK (changeset_round >= 1),
  respawns_used integer NOT NULL CHECK (respawns_used >= 0),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('session', 'person', 'service')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  version integer NOT NULL CHECK (version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES tasks (workspace_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX tasks_one_root ON tasks (group_id) WHERE parent_id IS NULL;
--> statement-breakpoint
CREATE TABLE task_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  task_id text NOT NULL,
  group_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  kind text NOT NULL CHECK (
    kind IN ('created', 'transition', 'verification_mode_changed', 'owner_instruction')
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('session', 'person', 'service')),
  actor_id text NOT NULL,
  from_state text,
  to_state text,
  evidence jsonb NOT NULL,
  note text CHECK (note IS NULL OR octet_length(note) <= 4096),
  data jsonb NOT NULL,
  at timestamptz NOT NULL,
  UNIQUE (group_id, sequence),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, group_id) REFERENCES groups (workspace_id, id)
);
--> statement-breakpoint
CREATE FUNCTION task_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'task events are append-only';
END;
$fn$;
--> statement-breakpoint
CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW
  EXECUTE FUNCTION task_events_reject_change();
--> statement-breakpoint
CREATE FUNCTION tasks_reject_closed_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.state IN ('done', 'failed') AND (
    NEW.state IS DISTINCT FROM OLD.state
    OR NEW.verification_mode IS DISTINCT FROM OLD.verification_mode
  ) THEN
    RAISE EXCEPTION 'a closed task cannot change state';
  END IF;
  RETURN NEW;
END;
$fn$;
--> statement-breakpoint
CREATE TRIGGER tasks_closed_state
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_reject_closed_change();
