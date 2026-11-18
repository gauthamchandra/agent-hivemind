ALTER TABLE sessions
  ADD COLUMN platform_stop_pending boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE sessions
SET platform_stop_pending = true
WHERE life IN ('ended', 'start_failed')
  AND platform_session_ref IS NOT NULL
  AND final_usage_pending;
