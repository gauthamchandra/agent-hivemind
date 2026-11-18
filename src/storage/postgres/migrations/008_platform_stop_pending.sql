ALTER TABLE sessions
  ADD COLUMN platform_stop_pending boolean NOT NULL DEFAULT false;
