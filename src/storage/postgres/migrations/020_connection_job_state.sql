CREATE TABLE connection_job_state (
  connection_id text PRIMARY KEY REFERENCES connections (id),
  workspace_id text NOT NULL REFERENCES workspaces (id),
  failing boolean NOT NULL
);
--> statement-breakpoint
COMMENT ON TABLE connection_job_state IS 'What housekeeping remembers about one connection between probes: whether the last probe failed.';
