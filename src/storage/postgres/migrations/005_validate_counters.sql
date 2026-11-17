ALTER TABLE workspaces VALIDATE CONSTRAINT workspaces_live_sessions_check;
--> statement-breakpoint
ALTER TABLE groups VALIDATE CONSTRAINT groups_live_sessions_check;
--> statement-breakpoint
ALTER TABLE groups VALIDATE CONSTRAINT groups_live_planner_check;
--> statement-breakpoint
ALTER TABLE groups VALIDATE CONSTRAINT groups_live_challenger_check;
--> statement-breakpoint
ALTER TABLE groups VALIDATE CONSTRAINT groups_live_implementer_check;
--> statement-breakpoint
ALTER TABLE groups VALIDATE CONSTRAINT groups_total_sessions_check;
