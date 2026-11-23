-- Housekeeping sets hivemind.retention for the transaction that removes a closed group.
-- Every update, and every other delete, is still rejected.
CREATE OR REPLACE FUNCTION task_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('hivemind.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'task events are append-only';
END;
$fn$;
