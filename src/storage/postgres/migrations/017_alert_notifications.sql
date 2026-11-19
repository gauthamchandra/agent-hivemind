ALTER TABLE alerts ADD COLUMN notified_at timestamptz;
--> statement-breakpoint
CREATE TABLE alert_deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  alert_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'sent', 'failed', 'expired')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX alert_deliveries_one_outstanding
  ON alert_deliveries (alert_id)
  WHERE state IN ('sending', 'failed');
--> statement-breakpoint
COMMENT ON TABLE alert_deliveries IS 'One notification for one alert. At most one is outstanding per alert, its id stays the same across a retry, and attempts counts the sends.';
