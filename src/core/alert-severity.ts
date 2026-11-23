import type { DesiredAlert } from '@/core/alert-rules.ts';
import type { AlertRule, AlertSeverity } from '@/domain/background-jobs.ts';
import type { GroupId, WorkspaceId } from '@/domain/ids.ts';

const severity: Record<AlertRule, AlertSeverity> = {
  session_dead: 'critical',
  session_waiting_for_person: 'critical',
  session_not_enrolled: 'critical',
  session_idle_on_open_task: 'normal',
  wait_expired: 'normal',
  wait_overdue: 'critical',
  task_stalled: 'normal',
  task_without_session: 'normal',
  budget_80: 'normal',
  budget_reached: 'critical',
  session_over_role_ceiling: 'normal',
  root_needs_decision: 'normal',
  escalation: 'critical',
  delivery_backlog: 'normal',
  end_not_confirmed: 'normal',
  end_pending: 'critical',
  start_unresolved: 'critical',
  orphan_platform_session_ended: 'normal',
  instruction_relayed: 'normal',
  spend_unknown: 'normal',
  connection_failing: 'critical',
};

export function severityOf(rule: AlertRule): AlertSeverity {
  return severity[rule];
}

export function push(
  desired: DesiredAlert[],
  rule: AlertRule,
  targetId: string,
  workspaceId: WorkspaceId,
  groupId: GroupId | null,
  reason: string | null
): void {
  desired.push({
    rule,
    targetId,
    workspaceId,
    groupId,
    severity: severityOf(rule),
    reason,
  });
}

export function held(nowMs: number, at: string | null, limit: number): boolean {
  if (at === null) return false;

  return nowMs - Date.parse(at) >= limit;
}
