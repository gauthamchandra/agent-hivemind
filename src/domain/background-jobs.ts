import type { SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { Group, SessionRecord, Task } from '@/domain/model.ts';

/** How often the worker may start each job. The job lock, not the timer, decides which process runs it. */
export const reaperIntervalMs = 15 * 60 * 1000;

/** A write extends the expiry while its lock id still matches. A worker that stops blocks the job until the expiry passes. */
export const jobLockMs = 4 * 60 * 1000;
/** How often a worker looks for a due job, and how close to expiry a write must be to extend the lock by `jobLockMs`. */
export const jobLockCheckMs = 60 * 1000;

export const reaperDeadlineMs = 10 * 60 * 1000;

export const closedTaskGraceMs = 60 * 60 * 1000;
export const startingResolveMs = 10 * 60 * 1000;

/**
 * A complete find that returns absent is trusted only inside this window.
 * Past it, an absent answer waits for a person instead of freeing the place.
 */
export const searchWindowMs = 24 * 60 * 60 * 1000;

export const suspendIdleMs = 24 * 60 * 60 * 1000;

const jobNames = ['usage_poll', 'reaper', 'housekeeping'] as const;
export type JobName = (typeof jobNames)[number];

export function isJobName(value: string): value is JobName {
  return jobNames.some(job => job === value);
}

export type SessionJobState = {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  unknownStreak: number;
  endUnconfirmedRuns: number;
  endAttemptRuns: number;
  inconclusiveRuns: number;
  lastFind: 'found' | 'absent' | 'inconclusive' | null;
  suspendedAt: string | null;
  suspendedProgressAt: string | null;
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
};

export function emptySessionJobState(
  sessionId: SessionId,
  workspaceId: WorkspaceId
): SessionJobState {
  return {
    sessionId,
    workspaceId,
    unknownStreak: 0,
    endUnconfirmedRuns: 0,
    endAttemptRuns: 0,
    inconclusiveRuns: 0,
    lastFind: null,
    suspendedAt: null,
    suspendedProgressAt: null,
    orphanEnded: false,
  };
}
