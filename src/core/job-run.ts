import type { ServiceDeps } from '@/core/deps.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import type { JobName } from '@/domain/background-jobs.ts';
import { jobLockMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { WorkspaceId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';

export type RunOptions = {
  workerId: string;
  crashAt?: 'after_planned_action';
};

export type JobRunResult = { ran: true; lockId: number } | { ran: false; lockId: null };

/** A different string for each process, stored as `job_locks.locked_by`. */
export function createWorkerId(bytes: Uint8Array): string {
  return `hivemind-svc:${Buffer.from(bytes).toString('hex')}`;
}

export async function takeJob(
  deps: ServiceDeps,
  job: JobName,
  workerId: string,
  intervalMs: number
): Promise<number | null> {
  const nowMs = deps.clock.now().getTime();
  const started = await deps.store.transact(tx => tx.jobLockStartedAt(job));

  if (started !== null && Date.parse(started) > nowMs - intervalMs) return null;

  return deps.store.transact(tx =>
    tx.takeJobLock({
      job,
      lockedBy: workerId,
      now: formatTime(new Date(nowMs)),
      expiresAt: formatTime(new Date(nowMs + jobLockMs)),
      dueAt: formatTime(new Date(nowMs - intervalMs)),
    })
  );
}

export async function recordPlannedAction(
  deps: ServiceDeps,
  options: RunOptions,
  job: JobName,
  lockId: number,
  action: string,
  targetId: string,
  workspaceId: WorkspaceId
): Promise<string> {
  const now = formatTime(deps.clock.now());
  const id = `${job}:${action}:${targetId}:${lockId}`;
  const outcome = await deps.store.transact(tx =>
    tx.insertPlannedAction({ id, job, action, targetId, workspaceId, lockId, now })
  );

  if (outcome === 'stale') {
    throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
  }

  if (outcome === 'open') {
    const rows = await deps.store.transact(tx => tx.openPlannedActions(job));
    const open = rows.find(row => row.action === action && row.targetId === targetId);

    if (open === undefined) {
      throw new HivemindError('conflict', 'The open planned action disappeared.');
    }

    return open.id;
  }

  if (options.crashAt === 'after_planned_action') throw new StoppedProcess('after_planned_action');

  return id;
}

export async function finishRecordedPlannedAction(
  deps: ServiceDeps,
  job: JobName,
  lockId: number,
  plannedActionId: string
): Promise<void> {
  const now = formatTime(deps.clock.now());
  const finished = await deps.store.transact(tx =>
    tx.finishPlannedAction(plannedActionId, job, lockId, now)
  );

  if (!finished) throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
}
