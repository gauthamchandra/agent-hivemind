CREATE TABLE connections (
  workspace_id text PRIMARY KEY REFERENCES workspaces (id),
  id text NOT NULL UNIQUE,
  adapter text NOT NULL,
  created_at timestamptz NOT NULL
);
