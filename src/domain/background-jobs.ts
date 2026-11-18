import type { AlertId, GroupId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type {
  Group,
  NeutralStatus,
  SessionRecord,
  SessionRole,
  Task,
  TaskState,
} from '@/domain/model.ts';

/** How often the worker may start each job. The job lock, not the timer, decides which process runs it. */
export const usagePollIntervalMs = 5 * 60 * 1000;
export const reaperIntervalMs = 15 * 60 * 1000;

/** A write extends the expiry while its lock id still matches. A worker that stops blocks the job until the expiry passes. */
export const jobLockMs = 4 * 60 * 1000;
/** How often a worker looks for a due job, and how close to expiry a write must be to extend the lock by `jobLockMs`. */
export const jobLockCheckMs = 60 * 1000;

export const usagePollDeadlineMs = 4 * 60 * 1000;
export const reaperDeadlineMs = 10 * 60 * 1000;
export const recordsPerWorkspace = 200;

export const closedTaskGraceMs = 60 * 60 * 1000;
export const startingResolveMs = 10 * 60 * 1000;

/**
 * A complete find that returns absent is trusted only inside this window.
 * Past it, an absent answer waits for a person instead of freeing the place.
 */
export const searchWindowMs = 24 * 60 * 60 * 1000;

export const suspendIdleMs = 24 * 60 * 60 * 1000;

export const deadReadings = 2;
export const waitingForPersonMs = 10 * 60 * 1000;
export const notEnrolledMs = 10 * 60 * 1000;
export const idleOnTaskMs = 60 * 60 * 1000;
export const waitOverdueMs = 30 * 60 * 1000;
export const taskStalledMs = 6 * 60 * 60 * 1000;
export const taskWithoutSessionMs = 30 * 60 * 1000;
export const deliveryBacklogMs = 15 * 60 * 1000;
export const spendUnknownMs = 60 * 60 * 1000;
export const endNotConfirmedRuns = 3;
export const endPendingRuns = 6;
export const startUnresolvedRuns = 6;

const jobNames = ['usage_poll', 'reaper', 'housekeeping'] as const;
export type JobName = (typeof jobNames)[number];

export function isJobName(value: string): value is JobName {
  return jobNames.some(job => job === value);
}

export const alertRules = [
  'session_dead',
  'session_waiting_for_person',
  'session_not_enrolled',
  'session_idle_on_open_task',
  'wait_expired',
  'wait_overdue',
  'wait_cycle',
  'task_stalled',
  'task_without_session',
  'budget_80',
  'budget_reached',
  'session_over_role_ceiling',
  'root_needs_decision',
  'delivery_backlog',
  'end_not_confirmed',
  'end_pending',
  'start_unresolved',
  'orphan_platform_session_ended',
  'instruction_relayed',
  'spend_unknown',
] as const;

export type AlertRule = (typeof alertRules)[number];
export type AlertSeverity = 'normal' | 'critical';

/** These rules read the platform. A failed read must not open or clear them. */
export const statusDependentRules: ReadonlySet<AlertRule> = new Set([
  'session_dead',
  'session_waiting_for_person',
  'session_idle_on_open_task',
  'session_over_role_ceiling',
  'task_stalled',
  'end_not_confirmed',
  'end_pending',
]);

export function isAlertRule(value: string): value is AlertRule {
  return alertRules.some(rule => rule === value);
}

export function isDeadStatus(status: NeutralStatus | null): boolean {
  switch (status) {
    case 'stopped':
    case 'failed':
    case 'unknown':
      return true;
    default:
      return false;
  }
}

const childRole: Record<TaskState, SessionRole | null> = {
  planned: 'implementer',
  analyzing: null,
  implementing: 'implementer',
  in_review: 'reviewer',
  approved: 'reviewer',
  verifying_before_merge: 'verifier',
  merging: 'reviewer',
  verifying_after_merge: 'verifier',
  done: null,
  failed: null,
};

/** The role a task state is waiting on. Both alert rules that mention it use this table. */
export function roleExpectedToAct(task: Task): SessionRole | null {
  if (task.parent_id === null) {
    if (task.state === 'planned' || task.state === 'analyzing') return 'planner';

    return null;
  }

  return childRole[task.state];
}

export function alertKey(rule: AlertRule, targetId: string): string {
  return `${rule}:${targetId}`;
}

export type AlertRecord = {
  id: AlertId;
  workspaceId: WorkspaceId;
  groupId: GroupId | null;
  rule: AlertRule;
  targetId: string;
  severity: AlertSeverity;
  reason: string | null;
  openedAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
};

export type SessionJobState = {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  badStatusStreak: number;
  unknownStreak: number;
  endUnconfirmedRuns: number;
  endAttemptRuns: number;
  inconclusiveRuns: number;
  lastFind: 'found' | 'absent' | 'inconclusive' | null;
  suspendedAt: string | null;
  suspendedProgressAt: string | null;
  statusSince: string | null;
  lastReadingAt: string | null;
  lastAttemptAt: string | null;
  usageGrewAt: string | null;
  orphanEnded: boolean;
};

export type PlannedAction = {
  id: string;
  job: JobName;
  action: string;
  targetId: string;
  workspaceId: WorkspaceId;
  lockId: number;
  state: 'open' | 'done';
};

/** The rows one job run reads. The worker that holds the job lock is the only caller. */
export type JobSnapshot = {
  groups: Group[];
  tasks: Task[];
  sessions: SessionRecord[];
  waits: WaitRecord[];
  sessionJobStates: SessionJobState[];
  oldestQueuedAt: { connectionId: string; at: string }[];
  taskActivityAt: { taskId: string; at: string }[];
  relayedSessionIds: string[];
  orphanEndedSessions: { sessionId: string; groupId: string }[];
  unusedCodeExpires: { sessionId: string; expiresAt: string }[];
  alerts: AlertRecord[];
};

export function emptySessionJobState(
  sessionId: SessionId,
  workspaceId: WorkspaceId
): SessionJobState {
  return {
    sessionId,
    workspaceId,
    badStatusStreak: 0,
    unknownStreak: 0,
    endUnconfirmedRuns: 0,
    endAttemptRuns: 0,
    inconclusiveRuns: 0,
    lastFind: null,
    suspendedAt: null,
    suspendedProgressAt: null,
    statusSince: null,
    lastReadingAt: null,
    lastAttemptAt: null,
    usageGrewAt: null,
    orphanEnded: false,
  };
}

export function sessionJobStateFor(snapshot: JobSnapshot, session: SessionRecord): SessionJobState {
  const found = snapshot.sessionJobStates.find(jobState => jobState.sessionId === session.id);

  if (found !== undefined) return found;

  const created = emptySessionJobState(session.id, session.workspace_id);

  snapshot.sessionJobStates.push(created);

  return created;
}
