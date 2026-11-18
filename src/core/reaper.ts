import type { ServiceDeps } from '@/core/deps.ts';
import {
  endFinishedPlanner,
  endFor,
  noteEndAttempt,
  noteOrphan,
  resolveStart,
  suspendIdle,
  watchFor,
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
import { PlatformError } from '@/domain/platform.ts';
import type { FleetSnapshot } from '@/domain/supervision.ts';
import {
  closedTaskGraceMs,
  emptyWatch,
  reaperDeadlineMs,
  reaperIntervalMs,
} from '@/domain/supervision.ts';
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

      console.error(`Reaper skipped session ${session.id}.`);
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
  if (await endClosedTask(deps, platforms, session, task, epoch, options)) return;
  if (await endFinishedPlanner(deps, platforms, snapshot, session, task, epoch, options)) return;

  await resolveStart(deps, platforms, snapshot, session, epoch, options);
  await resumeUnfinishedEnd(deps, platforms, session, epoch, options);
  await endUnknown(deps, platforms, snapshot, session, task, epoch, options);
  await noteOrphan(deps, platforms, snapshot, session, epoch, options);
}

async function endClosedTask(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord,
  task: Task,
  epoch: number,
  options: RunOptions
): Promise<boolean> {
  if (session.life !== 'live' && session.life !== 'released') return false;
  if (!isClosedState(task.state) || task.closed_at === null) return false;
  if (deps.clock.now().getTime() - Date.parse(task.closed_at) < closedTaskGraceMs) return false;

  await endFor(deps, platforms, session, epoch, options, 'task_closed');

  return true;
}

async function resumeUnfinishedEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord,
  epoch: number,
  options: RunOptions
): Promise<void> {
  if (
    session.end_requested_at === null ||
    session.life === 'ended' ||
    session.life === 'start_failed'
  ) {
    return;
  }

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
    const watch = emptyWatch(session.id, session.workspace_id);

    watch.endAttemptRuns = 0;
    await deps.store.transact(tx => tx.saveWatch(watch));
    await finishRecordedIntent(deps, 'reaper', epoch, intentId);
  } catch (error) {
    if (error instanceof PlatformError) {
      await noteEndAttempt(deps, session);
      return;
    }

    throw error;
  }
}

async function endUnknown(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  task: Task,
  epoch: number,
  options: RunOptions
): Promise<void> {
  const watch = watchFor(snapshot, session);

  if (watch.unknownStreak < 2) return;
  if (session.life !== 'live' && session.life !== 'released') return;
  if (isClosedState(task.state)) return;

  await endFor(deps, platforms, session, epoch, options, 'unknown_to_platform');
}

async function correctCaps(deps: ServiceDeps, epoch: number): Promise<void> {
  const now = formatTime(deps.clock.now());
  const corrected = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('reaper', epoch, now))) return [];

    return tx.correctCounters();
  });

  for (const id of corrected) console.warn(`Cap counters were corrected for group ${id}.`);
}
