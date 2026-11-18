import type { ServiceDeps } from '@/core/deps.ts';
import {
  endFor,
  isPlatformStopFailure,
  noteEndAttempt,
  noteOrphan,
  resolveStart,
  suspendIdle,
  watchFor,
  writeReaperWatch,
} from '@/core/reaper-actions.ts';
import { resumeEnd } from '@/core/session-end.ts';
import {
  finishRecordedIntent,
  type RunOptions,
  recordIntent,
  SupervisionHalted,
  type TickResult,
  takeJob,
} from '@/core/supervision-run.ts';
import type { SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import type { FleetSnapshot } from '@/domain/supervision.ts';
import { closedTaskGraceMs, reaperDeadlineMs, reaperIntervalMs } from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function runReaper(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<TickResult> {
  const epoch = await takeJob(deps, 'reaper', options.workerId, reaperIntervalMs);

  if (epoch === null) return { ran: false, epoch: null };

  const started = deps.clock.now().getTime();
  const snapshot = await deps.store.transact(tx => tx.loadFleet());

  for (const session of snapshot.sessions) {
    if (deps.clock.now().getTime() - started > reaperDeadlineMs) break;

    try {
      await tend(deps, platforms, snapshot, session, epoch, options);
    } catch (error) {
      if (error instanceof SupervisionHalted) throw error;

      console.error(
        `Reaper skipped session ${session.id}. It looks at that session again on the next run.`,
        error
      );
    }
  }

  await correctCaps(deps, epoch);

  return { ran: true, epoch };
}

async function tend(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  options: RunOptions
): Promise<void> {
  const task = snapshot.tasks.find(item => item.id === session.task_id);
  const group = snapshot.groups.find(item => item.id === session.group_id);

  if (task === undefined || group === undefined) return;

  if (await suspendIdle(deps, platforms, snapshot, session, task, epoch, options)) return;
  if (await endClosedTask(deps, platforms, snapshot, session, task, epoch, options)) return;

  await resolveStart(deps, platforms, snapshot, session, epoch, options);
  await resumeUnfinishedEnd(deps, platforms, snapshot, session, epoch, options);
  await noteOrphan(deps, platforms, snapshot, session, epoch, options);
}

async function endClosedTask(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  task: Task,
  epoch: number,
  options: RunOptions
): Promise<boolean> {
  if (session.life !== 'live' && session.life !== 'released') return false;
  if (!isClosedState(task.state) || task.closed_at === null) return false;
  if (deps.clock.now().getTime() - Date.parse(task.closed_at) < closedTaskGraceMs) return false;

  await endFor(deps, platforms, snapshot, session, epoch, options, 'task_closed');

  return true;
}

async function resumeUnfinishedEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  options: RunOptions
): Promise<void> {
  if (session.life === 'start_failed') return;
  if (session.life === 'ended' && !session.final_usage_pending && !session.platform_stop_pending) {
    return;
  }
  if (session.life !== 'ended' && session.end_requested_at === null) return;

  const intentId = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'resume_end',
    session.id,
    session.workspace_id
  );

  try {
    await resumeEnd(deps, platforms, {
      workspaceId: session.workspace_id,
      sessionId: session.id,
    });
    const watch = watchFor(snapshot, session);

    watch.endAttemptRuns = 0;
    watch.endUnconfirmedRuns = 0;
    await writeReaperWatch(deps, epoch, watch);
    await finishRecordedIntent(deps, 'reaper', epoch, intentId);
  } catch (error) {
    if (isPlatformStopFailure(error)) {
      await noteEndAttempt(deps, snapshot, session, epoch, error);
      return;
    }

    throw error;
  }
}

async function correctCaps(deps: ServiceDeps, epoch: number): Promise<void> {
  const now = formatTime(deps.clock.now());
  const corrected = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('reaper', epoch, now))) return [];

    return tx.correctCounters();
  });

  for (const id of corrected) console.warn(`Cap counters were corrected for group ${id}.`);
}
