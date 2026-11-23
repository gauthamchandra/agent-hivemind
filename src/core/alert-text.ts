import type { AlertRule } from '@/domain/background-jobs.ts';

type AlertWords = { summary: string; action: string };

const words: Record<AlertRule, AlertWords> = {
  session_dead: {
    summary: 'A session looks stopped while its task is still open.',
    action: 'Read the session and decide whether to start a replacement.',
  },
  session_waiting_for_person: {
    summary: 'A session is waiting for a person.',
    action: 'Answer the session or end it.',
  },
  session_not_enrolled: {
    summary: 'A session has not enrolled.',
    action: 'Check that the session can reach the service.',
  },
  session_idle_on_open_task: {
    summary: 'A session is idle on a task that still expects it.',
    action: 'Check the task, or end the session.',
  },
  wait_expired: {
    summary: 'A wait passed its deadline.',
    action: 'Answer the waiting session or clear the wait.',
  },
  wait_overdue: {
    summary: 'A wait is still open well after its deadline.',
    action: 'Answer the waiting session or clear the wait.',
  },
  task_stalled: {
    summary: 'A task has had no activity for hours.',
    action: 'Read the task and decide whether it is stuck.',
  },
  task_without_session: {
    summary: 'A task expects a role that nobody holds.',
    action: 'Start the missing member or change the task.',
  },
  budget_80: {
    summary: 'Spend has reached 80 percent of the budget.',
    action: 'Raise the budget or let the running sessions finish.',
  },
  budget_reached: {
    summary: 'Spend has reached the budget.',
    action: 'Raise the budget. New starts are refused.',
  },
  session_over_role_ceiling: {
    summary: 'A session is above its role ceiling.',
    action: 'End the session or accept the extra usage.',
  },
  root_needs_decision: {
    summary: 'Every child task is closed and at least one failed.',
    action: 'Decide what the root task should do next.',
  },
  escalation: {
    summary: 'A session asked a person for help.',
    action: 'Read the reason and answer the session.',
  },
  delivery_backlog: {
    summary: 'A message has been waiting to be delivered.',
    action: 'Check the connection and the delivery worker.',
  },
  end_not_confirmed: {
    summary: 'An ended session still appears to be running.',
    action: 'Stop it on the platform.',
  },
  end_pending: {
    summary: 'An end was requested and the platform has not confirmed it.',
    action: 'Stop the session, or force the end.',
  },
  start_unresolved: {
    summary: 'A start has not been resolved.',
    action: 'Attach the platform session or declare it absent.',
  },
  orphan_platform_session_ended: {
    summary: 'A platform session from a failed start was stopped.',
    action: 'Confirm the start failure was expected.',
  },
  instruction_relayed: {
    summary: 'A session relayed an instruction it says a person gave.',
    action: 'Confirm or correct the instruction.',
  },
  spend_unknown: {
    summary: 'Spend cannot be read for a group.',
    action: 'Restore usage readings or allow the group to run without them.',
  },
  connection_failing: {
    summary: 'A connection failed its daily probe.',
    action: 'Check the connection and the platform.',
  },
};

/** What an alert means and what a person should do about it, in words for a notification. */
export function alertWords(rule: AlertRule): AlertWords {
  return words[rule];
}
