import { probeConnections } from '@/core/connection-probe.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { type JobRunResult, type RunOptions, takeJob } from '@/core/job-run.ts';
import { housekeepingDeadlineMs, housekeepingIntervalMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

/**
 * Remove closed groups that have passed their retention, then probe each connection.
 *
 * <p>Each group, and each probe result, is one transaction under this run's lock id. The run
 * stops between groups, and between connections, once {@link housekeepingDeadlineMs} has passed.
 * The next run is 24 hours later. A session that is starting, live, or released, or that still
 * owes a final reading or a platform stop, keeps its group.
 */
export async function runHousekeeping(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<JobRunResult> {
  const lockId = await takeJob(deps, 'housekeeping', options.workerId, housekeepingIntervalMs);

  if (lockId === null) return { ran: false, lockId: null };

  const started = deps.clock.now().getTime();
  const closedBefore = formatTime(new Date(started - deps.closedGroupRetentionMs));
  const groupIds = await deps.store.transact(tx => tx.groupsClosedBefore(closedBefore));

  for (const groupId of groupIds) {
    if (deps.clock.now().getTime() - started > housekeepingDeadlineMs) break;

    await removeOne(deps, groupId, lockId, closedBefore);
  }

  await probeConnections(deps, platforms, options, lockId, started);

  return { ran: true, lockId };
}

async function removeOne(
  deps: ServiceDeps,
  groupId: GroupId,
  lockId: number,
  closedBefore: string
): Promise<void> {
  const now = formatTime(deps.clock.now());
  const outcome = await deps.store.transact(tx =>
    tx.removeClosedGroup({ groupId, lockId, now, closedBefore })
  );

  if (outcome === 'stale') {
    throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
  }
}
