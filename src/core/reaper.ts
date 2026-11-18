import type { ServiceDeps } from '@/core/deps.ts';
import {
  finishRecordedPlannedAction,
  type JobRunResult,
  type RunOptions,
  recordPlannedAction,
  takeJob,
} from '@/core/job-run.ts';
import {
  endFor,
  isPlatformStopFailure,
  noteEndAttempt,
  noteOrphan,
  resolveStart,
  suspendIdle,
  writeReaperJobState,
} from '@/core/reaper-actions.ts';
import { resumeEnd } from '@/core/session-end.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import type { JobSnapshot } from '@/domain/background-jobs.ts';
import {
  closedTaskGraceMs,
  reaperDeadlineMs,
  reaperIntervalMs,
  sessionJobStateFor,
} from '@/domain/background-jobs.ts';
import type { SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function runReaper(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<JobRunResult> {
  const lockId = await takeJob(deps, 'reaper', options.workerId, reaperIntervalMs);

  if (lockId === null) return { ran: false, lockId: null };

  const started = deps.clock.now().getTime();
  const snapshot = await deps.store.transact(tx => tx.loadJobSnapshot());

  for (const session of snapshot.sessions) {
    if (deps.clock.now().getTime() - started > reaperDeadlineMs) break;

    try {
      await tend(deps, platforms, snapshot, session, lockId, options);
    } catch (error) {
      if (error instanceof StoppedProcess) throw error;

      console.error(
        `Reaper skipped session ${session.id}. It looks at that session again on the next run.`,
        error
      );
    }
  }

  await correctCaps(deps, lockId);

  return { ran: true, lockId };
}

async function tend(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
  options: RunOptions
): Promise<void> {
  const task = snapshot.tasks.find(item => item.id === session.task_id);
  const group = snapshot.groups.find(item => item.id === session.group_id);

  if (task === undefined || group === undefined) return;

  if (await suspendIdle(deps, platforms, snapshot, session, task, lockId, options)) return;
  if (await endClosedTask(deps, platforms, snapshot, session, task, lockId, options)) return;

  await resolveStart(deps, platforms, snapshot, session, lockId, options);
  await resumeUnfinishedEnd(deps, platforms, snapshot, session, lockId, options);
  await noteOrphan(deps, platforms, snapshot, session, lockId, options);
}

async function endClosedTask(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  task: Task,
  lockId: number,
  options: RunOptions
): Promise<boolean> {
  if (session.life !== 'live' && session.life !== 'released') return false;
  if (!isClosedState(task.state) || task.closed_at === null) return false;
  if (deps.clock.now().getTime() - Date.parse(task.closed_at) < closedTaskGraceMs) return false;

  await endFor(deps, platforms, snapshot, session, lockId, options, 'task_closed');

  return true;
}

async function resumeUnfinishedEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
  options: RunOptions
): Promise<void> {
  if (session.life === 'start_failed') return;
  if (session.life === 'ended' && !session.final_usage_pending && !session.platform_stop_pending) {
    return;
  }
  if (session.life !== 'ended' && session.end_requested_at === null) return;

  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
    'resume_end',
    session.id,
    session.workspace_id
  );

  try {
    await resumeEnd(deps, platforms, {
      workspaceId: session.workspace_id,
      sessionId: session.id,
    });
    const jobState = sessionJobStateFor(snapshot, session);

    jobState.endAttemptRuns = 0;
    jobState.endUnconfirmedRuns = 0;
    await writeReaperJobState(deps, lockId, jobState);
    await finishRecordedPlannedAction(deps, 'reaper', lockId, plannedActionId);
  } catch (error) {
    if (isPlatformStopFailure(error)) {
      await noteEndAttempt(deps, snapshot, session, lockId, error);
      return;
    }

    throw error;
  }
}

async function correctCaps(deps: ServiceDeps, lockId: number): Promise<void> {
  const now = formatTime(deps.clock.now());
  const corrected = await deps.store.transact(async tx => {
    if (!(await tx.holdJobLock('reaper', lockId, now))) return [];

    return tx.correctCounters();
  });

  for (const id of corrected) console.warn(`Cap counters were corrected for group ${id}.`);
}
