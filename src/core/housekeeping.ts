import type { ServiceDeps } from '@/core/deps.ts';
import { type RunOptions, recordIntent, type TickResult, takeJob } from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, WorkspaceId } from '@/domain/ids.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { ConnectionWatch, FleetSnapshot } from '@/domain/supervision.ts';
import {
  housekeepingDeadlineMs,
  housekeepingIntervalMs,
  rateRowMaxAgeMs,
  retentionMs,
} from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function runHousekeeping(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<TickResult> {
  const epoch = await takeJob(deps, 'housekeeping', options.workerId, housekeepingIntervalMs);

  if (epoch === null) return { ran: false, epoch: null };

  const now = formatTime(deps.clock.now());
  const snapshot = await deps.store.transact(tx => tx.loadFleet());

  await probeConnections(deps, platforms, snapshot, epoch, options, now);
  await deleteOldRows(deps, epoch, now);
  await retain(deps, epoch);

  return { ran: true, epoch };
}

/** Write the connection watch only while this epoch still holds the housekeeping lease. */
export async function writeConnectionWatch(
  deps: ServiceDeps,
  epoch: number,
  watch: ConnectionWatch
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('housekeeping', epoch, formatTime(deps.clock.now())))) return false;

    await tx.saveConnectionWatch(watch);

    return true;
  });

  if (!wrote) throw new HivemindError('conflict', 'The lease epoch is no longer current.');
}

/** Remove one closed group only while this epoch still holds the housekeeping lease. */
export async function retainClosedGroup(
  deps: ServiceDeps,
  epoch: number,
  workspaceId: WorkspaceId,
  groupId: GroupId
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('housekeeping', epoch, formatTime(deps.clock.now())))) return false;

    await tx.retainGroup(workspaceId, groupId);

    return true;
  });

  if (!wrote) throw new HivemindError('conflict', 'The lease epoch is no longer current.');
}

async function probeConnections(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  epoch: number,
  options: RunOptions,
  now: string
): Promise<void> {
  const seen = new Set<string>();

  const started = deps.clock.now().getTime();

  for (const connection of snapshot.connections) {
    if (deps.clock.now().getTime() - started > housekeepingDeadlineMs) break;
    if (seen.has(connection.id)) continue;

    seen.add(connection.id);

    const intentId = await recordIntent(
      deps,
      options,
      'housekeeping',
      epoch,
      'probe',
      connection.id,
      connection.workspaceId
    );
    const watch = connectionWatch(snapshot, connection.id, connection.workspaceId);
    const failed = await probeOne(platforms, connection.id);

    watch.probeFailed = failed.failed;
    if (failed.auth) watch.authFailStreak += 1;
    else if (!failed.failed) watch.authFailStreak = 0;
    if (!failed.failed) watch.lastProbeAt = now;
    await saveProbe(deps, epoch, intentId, watch);
  }
}

async function saveProbe(
  deps: ServiceDeps,
  epoch: number,
  intentId: string,
  watch: ConnectionWatch
): Promise<void> {
  await deps.store.transact(async tx => {
    const now = formatTime(deps.clock.now());

    if (!(await tx.holdLease('housekeeping', epoch, now))) {
      throw new HivemindError('conflict', 'The lease epoch is no longer current.');
    }

    await tx.saveConnectionWatch(watch);

    if (!(await tx.finishIntent(intentId, 'housekeeping', epoch, now))) {
      throw new HivemindError('conflict', 'The lease epoch is no longer current.');
    }
  });
}

async function probeOne(
  platforms: Platforms,
  connectionId: FleetSnapshot['connections'][number]['id']
): Promise<{ failed: boolean; auth: boolean }> {
  try {
    const handle = platforms.require(connectionId);

    await handle.adapter.probe(handle.connection);

    return { failed: false, auth: false };
  } catch (error) {
    if (error instanceof PlatformError) {
      return { failed: true, auth: error.errorClass === 'auth' };
    }

    console.error(`Probe of connection ${connectionId} failed unexpectedly.`, error);

    return { failed: true, auth: false };
  }
}

async function deleteOldRows(deps: ServiceDeps, epoch: number, now: string): Promise<void> {
  const cutoff = formatTime(new Date(deps.clock.now().getTime() - rateRowMaxAgeMs));

  await deps.store.transact(async tx => {
    if (!(await tx.holdLease('housekeeping', epoch, now))) return;

    await tx.deleteExpiredCodes(now);
    await tx.deleteOldRateRows(cutoff);
    await tx.deleteOldSpawns(cutoff);
    await tx.deleteAgedSupervision(cutoff);
  });
}

async function retain(deps: ServiceDeps, epoch: number): Promise<void> {
  const now = formatTime(deps.clock.now());
  const instant = formatTime(new Date(deps.clock.now().getTime() - retentionMs));
  const closed = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('housekeeping', epoch, now))) return [];

    return tx.groupsClosedBefore(instant);
  });

  for (const group of closed) {
    const sessions = await deps.store.sessions(group.workspaceId, group.id);
    const busy = sessions.some(
      session =>
        session.life === 'starting' ||
        session.life === 'live' ||
        session.life === 'released' ||
        session.final_usage_pending ||
        session.platform_stop_pending
    );

    if (busy) continue;

    await retainClosedGroup(deps, epoch, group.workspaceId, group.id);
  }
}

function connectionWatch(
  snapshot: FleetSnapshot,
  connectionId: string,
  workspaceId: ConnectionWatch['workspaceId']
): ConnectionWatch {
  const found = snapshot.connectionWatches.find(watch => watch.connectionId === connectionId);

  if (found !== undefined) return found;

  return {
    connectionId,
    workspaceId,
    authFailStreak: 0,
    probeFailed: false,
    lastProbeAt: null,
  };
}
