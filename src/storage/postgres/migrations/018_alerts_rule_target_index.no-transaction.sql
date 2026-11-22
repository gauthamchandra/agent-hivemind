DROP INDEX CONCURRENTLY IF EXISTS alerts_rule_target;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY alerts_rule_target ON alerts (rule, target_id, notified_at);
