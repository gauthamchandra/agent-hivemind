import type { SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { Group, SessionRecord, Task } from '@/domain/model.ts';

/** How often the worker may start each job. The lease, not the timer, decides which process runs it. */
export const reaperIntervalMs = 15 * 60 * 1000;

/** A write extends the expiry while this epoch still matches. A holder that stops blocks the job until it passes. */
export const leaseMs = 4 * 60 * 1000;
/** How long before expiry a write pushes the lease out by `leaseMs`, and how often this process looks. */
export const leaseRenewMs = 60 * 1000;

export const reaperDeadlineMs = 10 * 60 * 1000;

export const closedTaskGraceMs = 60 * 60 * 1000;
export const startingResolveMs = 10 * 60 * 1000;

/**
 * A complete find that returns absent is trusted only inside this window.
 * Past it, an absent answer waits for a person instead of freeing the place.
 */
export const searchWindowMs = 24 * 60 * 60 * 1000;

export const suspendIdleMs = 24 * 60 * 60 * 1000;

const jobNames = ['fleet_check', 'reaper', 'housekeeping'] as const;
export type JobName = (typeof jobNames)[number];

export function isJobName(value: string): value is JobName {
  return jobNames.some(job => job === value);
}

export type SessionWatch = {
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

export type JobIntent = {
  id: string;
  job: JobName;
  action: string;
  targetId: string;
  workspaceId: WorkspaceId;
  epoch: number;
  state: 'open' | 'done';
};

/** The rows one supervision tick reads. The lease holder is the only caller. */
export type FleetSnapshot = {
  groups: Group[];
  tasks: Task[];
  sessions: SessionRecord[];
  waits: WaitRecord[];
  watches: SessionWatch[];
};

export function emptyWatch(sessionId: SessionId, workspaceId: WorkspaceId): SessionWatch {
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
