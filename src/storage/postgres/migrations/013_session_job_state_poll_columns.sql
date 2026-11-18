ALTER TABLE session_job_state
  ADD COLUMN last_reading_at timestamptz,
  ADD COLUMN last_attempt_at timestamptz;
