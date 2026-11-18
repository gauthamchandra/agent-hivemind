import type { ServiceDeps } from '@/core/deps.ts';
import { type RunOptions, type TickResult, takeJob } from '@/core/supervision-run.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { ConnectionWatch, FleetSnapshot } from '@/domain/supervision.ts';
import { housekeepingIntervalMs, rateRowMaxAgeMs, retentionMs } from '@/domain/supervision.ts';
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

  await probeConnections(deps, platforms, snapshot, now);
  await deps.store.transact(async tx => {
    const cutoff = formatTime(new Date(deps.clock.now().getTime() - rateRowMaxAgeMs));

    await tx.deleteExpiredCodes(now);
    await tx.deleteOldRateRows(cutoff);
    await tx.deleteOldSpawns(cutoff);
  });
  await retain(deps);

  return { ran: true, epoch };
}

async function probeConnections(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  now: string
): Promise<void> {
  const seen = new Set<string>();

  for (const connection of snapshot.connections) {
    if (seen.has(connection.id)) continue;

    seen.add(connection.id);
    const watch = connectionWatch(snapshot, connection.id, connection.workspaceId);

    try {
      await platforms
        .require(connection.id)
        .adapter.probe(platforms.require(connection.id).connection);
      watch.probeFailed = false;
      watch.authFailStreak = 0;
      watch.lastProbeAt = now;
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;

      watch.probeFailed = true;

      if (error.errorClass === 'auth') watch.authFailStreak += 1;
    }

    await deps.store.transact(tx => tx.saveConnectionWatch(watch));
  }
}

async function retain(deps: ServiceDeps): Promise<void> {
  const instant = formatTime(new Date(deps.clock.now().getTime() - retentionMs));
  const closed = await deps.store.transact(tx => tx.groupsClosedBefore(instant));

  for (const group of closed) {
    const sessions = await deps.store.sessions(group.workspaceId, group.id);
    const busy = sessions.some(
      session =>
        session.life === 'starting' || session.life === 'live' || session.life === 'released'
    );

    if (busy) continue;

    await deps.store.transact(tx => tx.retainGroup(group.workspaceId, group.id));
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
