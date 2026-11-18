import type { DesiredFinding } from '@/core/finding-rules.ts';
import type { GroupId, WorkspaceId } from '@/domain/ids.ts';
import type { FindingRule, FindingSeverity } from '@/domain/supervision.ts';

export function findingAudience(rule: FindingRule): ('owner' | 'administrator')[] {
  if (
    rule === 'delivery_backlog' ||
    rule === 'connection_failing' ||
    rule === 'end_not_confirmed' ||
    rule === 'orphan_platform_session_ended'
  ) {
    return ['administrator'];
  }

  if (rule === 'end_pending' || rule === 'start_unresolved') return ['owner', 'administrator'];

  return ['owner'];
}

export function findingWords(rule: FindingRule): { words: string; action: string } {
  return copy[rule];
}

export function severityOf(rule: FindingRule): FindingSeverity {
  if (
    rule === 'session_dead' ||
    rule === 'session_waiting_for_person' ||
    rule === 'session_not_enrolled' ||
    rule === 'wait_overdue' ||
    rule === 'wait_cycle' ||
    rule === 'budget_reached' ||
    rule === 'escalation' ||
    rule === 'connection_failing' ||
    rule === 'end_pending' ||
    rule === 'start_unresolved'
  ) {
    return 'critical';
  }

  return 'normal';
}

const copy: Record<FindingRule, { words: string; action: string }> = {
  session_dead: {
    words: 'A session looks stopped while its task is still open.',
    action: 'Read the session and decide whether to start a replacement.',
  },
  session_waiting_for_person: {
    words: 'A session is waiting for a person.',
    action: 'Answer the session or end it.',
  },
  session_not_enrolled: {
    words: 'A session has not enrolled.',
    action: 'Check that the session can reach the service.',
  },
  session_idle_on_open_task: {
    words: 'A session is idle on a task that still expects it.',
    action: 'Check the task, or end the session.',
  },
  wait_expired: {
    words: 'A wait passed its deadline.',
    action: 'Answer the waiting session or clear the wait.',
  },
  wait_overdue: {
    words: 'A wait is still open well after its deadline.',
    action: 'Answer the waiting session or clear the wait.',
  },
  wait_cycle: {
    words: 'Sessions are waiting on each other.',
    action: 'Clear one wait so the group can move.',
  },
  task_stalled: {
    words: 'A task has had no activity for hours.',
    action: 'Read the task and decide whether it is stuck.',
  },
  task_without_session: {
    words: 'A task expects a role that nobody holds.',
    action: 'Start the missing member or change the task.',
  },
  budget_80: {
    words: 'Spend has reached 80 percent of the budget.',
    action: 'Raise the budget or let the running sessions finish.',
  },
  budget_reached: {
    words: 'Spend has reached the budget.',
    action: 'Raise the budget. New starts are refused.',
  },
  session_over_role_ceiling: {
    words: 'A session is above its role ceiling.',
    action: 'End the session or accept the extra usage.',
  },
  root_needs_decision: {
    words: 'Every child task is closed and at least one failed.',
    action: 'Decide what the root task should do next.',
  },
  escalation: {
    words: 'A session asked a person for help.',
    action: 'Read the reason and answer the session.',
  },
  delivery_backlog: {
    words: 'A message has been waiting to be delivered.',
    action: 'Check the connection and the delivery worker.',
  },
  connection_failing: {
    words: 'A platform connection is failing.',
    action: 'Check the credential and the probe.',
  },
  end_not_confirmed: {
    words: 'An ended session still appears to be running.',
    action: 'Stop it on the platform.',
  },
  end_pending: {
    words: 'An end was requested and the platform has not confirmed it.',
    action: 'Stop the session, or force the end.',
  },
  start_unresolved: {
    words: 'A start has not been resolved.',
    action: 'Attach the platform session or declare it absent.',
  },
  orphan_platform_session_ended: {
    words: 'A platform session from a failed start was stopped.',
    action: 'Confirm the start failure was expected.',
  },
  instruction_relayed: {
    words: 'A session relayed an instruction it says a person gave.',
    action: 'Confirm or correct the instruction.',
  },
  spend_unknown: {
    words: 'Spend cannot be read for a group.',
    action: 'Restore usage readings or allow the group to run without them.',
  },
};

export function push(
  desired: DesiredFinding[],
  rule: FindingRule,
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
