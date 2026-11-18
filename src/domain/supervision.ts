import type { ConnectionId, GroupId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { Group, NeutralStatus, SessionRecord, SessionRole, Task } from '@/domain/model.ts';

/** How often the worker may start each job. The lease, not the timer, decides which process runs it. */
export const fleetIntervalMs = 5 * 60 * 1000;
export const reaperIntervalMs = 15 * 60 * 1000;
export const housekeepingIntervalMs = 24 * 60 * 60 * 1000;

/** A holder that stops blocks the job until this passes. The holder renews while the run continues. */
export const leaseMs = 4 * 60 * 1000;
export const leaseRenewMs = 60 * 1000;

export const fleetDeadlineMs = 4 * 60 * 1000;
export const reaperDeadlineMs = 10 * 60 * 1000;
export const housekeepingDeadlineMs = 30 * 60 * 1000;
export const recordsPerWorkspace = 200;

export const closedTaskGraceMs = 60 * 60 * 1000;
export const planningGraceMs = 60 * 60 * 1000;
export const startingResolveMs = 10 * 60 * 1000;

/**
 * A complete find that returns absent is trusted only inside this window.
 * Past it, an absent answer waits for a person instead of freeing the place.
 */
export const searchWindowMs = 24 * 60 * 60 * 1000;

export const deadReadings = 2;
export const waitingForPersonMs = 10 * 60 * 1000;
export const notEnrolledMs = 10 * 60 * 1000;
export const idleOnTaskMs = 60 * 60 * 1000;
export const waitOverdueMs = 30 * 60 * 1000;
export const taskStalledMs = 6 * 60 * 60 * 1000;
export const taskWithoutSessionMs = 30 * 60 * 1000;
export const suspendIdleMs = 24 * 60 * 60 * 1000;
export const deliveryBacklogMs = 15 * 60 * 1000;
export const spendUnknownMs = 60 * 60 * 1000;
export const retentionMs = 90 * 24 * 60 * 60 * 1000;
export const reminderNormalMs = 24 * 60 * 60 * 1000;
export const reminderCriticalMs = 4 * 60 * 60 * 1000;
export const endNotConfirmedRuns = 3;
export const endPendingRuns = 6;
export const startUnresolvedRuns = 6;
export const unknownReadings = 2;
export const authFailures = 3;
export const escalationCap = 10;
export const escalationWindowMs = 60 * 60 * 1000;
export const notifyRetryMs = 5 * 60 * 1000;
export const notifyGiveUpMs = 24 * 60 * 60 * 1000;
export const rateRowMaxAgeMs = 24 * 60 * 60 * 1000;

export const jobNames = ['fleet_check', 'reaper', 'housekeeping'] as const;
export type JobName = (typeof jobNames)[number];

export const findingRules = [
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
  'escalation',
  'delivery_backlog',
  'connection_failing',
  'end_not_confirmed',
  'end_pending',
  'start_unresolved',
  'orphan_platform_session_ended',
  'instruction_relayed',
  'spend_unknown',
] as const;

export type FindingRule = (typeof findingRules)[number];
export type FindingSeverity = 'normal' | 'critical';

/** These rules read the platform. A failed read must not open or clear them. */
export const statusDependentRules: ReadonlySet<FindingRule> = new Set([
  'session_dead',
  'session_waiting_for_person',
  'session_idle_on_open_task',
  'session_over_role_ceiling',
  'task_stalled',
  'end_not_confirmed',
  'end_pending',
]);

export function isJobName(value: string): value is JobName {
  return jobNames.some(job => job === value);
}

export function isFindingRule(value: string): value is FindingRule {
  return findingRules.some(rule => rule === value);
}

export function isDeadStatus(status: NeutralStatus | null): boolean {
  return status === 'stopped' || status === 'failed' || status === 'unknown';
}

/** The role a task state is waiting on. Both finding rules that mention it use this table. */
export function roleExpectedToAct(task: Task): SessionRole | null {
  const root = task.parent_id === null;

  if (root && (task.state === 'planned' || task.state === 'analyzing')) return 'planner';
  if (root) return null;
  if (task.state === 'planned' || task.state === 'implementing') return 'implementer';

  if (task.state === 'in_review' || task.state === 'approved' || task.state === 'merging') {
    return 'reviewer';
  }

  if (task.state === 'verifying_before_merge' || task.state === 'verifying_after_merge') {
    return 'verifier';
  }

  return null;
}

export function findingKey(rule: FindingRule, targetId: string): string {
  return `${rule}:${targetId}`;
}

export type SessionWatch = {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  badStatusStreak: number;
  unknownStreak: number;
  endUnconfirmedRuns: number;
  endAttemptRuns: number;
  inconclusiveRuns: number;
  lastFind: 'found' | 'absent' | 'inconclusive' | null;
  statusSince: string | null;
  lastReadingAt: string | null;
  suspendedAt: string | null;
  suspendedProgressAt: string | null;
  lastObservedAt: string | null;
  orphanEnded: boolean;
};

export type ConnectionWatch = {
  connectionId: string;
  workspaceId: WorkspaceId;
  authFailStreak: number;
  probeFailed: boolean;
  lastProbeAt: string | null;
};

export type FindingRecord = {
  id: string;
  workspaceId: WorkspaceId;
  groupId: GroupId | null;
  rule: FindingRule;
  targetId: string;
  severity: FindingSeverity;
  reason: string | null;
  openedAt: string;
  lastSeenAt: string;
  notifiedAt: string | null;
  acknowledgedAt: string | null;
  clearedAt: string | null;
  notify: boolean;
};

export type JobIntent = {
  id: string;
  job: JobName;
  action: string;
  targetId: string;
  workspaceId: WorkspaceId;
  epoch: number;
  state: 'open' | 'done';
};

export type NotificationAttempt = {
  id: string;
  workspaceId: WorkspaceId;
  deliveryId: string;
  recipientKind: 'owner' | 'administrator';
  recipientId: string;
  findingIds: string[];
  state: 'sending' | 'sent' | 'failed';
  createdAt: string;
  updatedAt: string;
};

/** The rows one supervision tick reads. The lease holder is the only caller. */
export type FleetSnapshot = {
  groups: Group[];
  tasks: Task[];
  sessions: SessionRecord[];
  waits: WaitRecord[];
  watches: SessionWatch[];
  connectionWatches: ConnectionWatch[];
  connections: { workspaceId: WorkspaceId; id: ConnectionId }[];
  oldestQueuedAt: { connectionId: string; at: string }[];
  taskActivityAt: { taskId: string; at: string }[];
  relayedSessionIds: string[];
  unusedCodeExpires: { sessionId: string; expiresAt: string }[];
  findings: FindingRecord[];
  attempts: NotificationAttempt[];
};

export function emptyWatch(sessionId: SessionId, workspaceId: WorkspaceId): SessionWatch {
  return {
    sessionId,
    workspaceId,
    badStatusStreak: 0,
    unknownStreak: 0,
    endUnconfirmedRuns: 0,
    endAttemptRuns: 0,
    inconclusiveRuns: 0,
    lastFind: null,
    statusSince: null,
    lastReadingAt: null,
    suspendedAt: null,
    suspendedProgressAt: null,
    lastObservedAt: null,
    orphanEnded: false,
  };
}
