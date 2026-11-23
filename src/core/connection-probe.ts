import { severityOf } from '@/core/alert-severity.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { type RunOptions, recordPlannedAction } from '@/core/job-run.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { housekeepingDeadlineMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { ConnectionId, WorkspaceId } from '@/domain/ids.ts';
import { PlatformError } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

type ListedConnection = { id: ConnectionId; workspaceId: WorkspaceId };

/**
 * Check each connection and open a `connection_failing` alert when the probe fails.
 *
 * <p>The platform call follows a planned action. The job state and the alert are written in one
 * transaction, and only while this run still holds the lock id. A connection the deadline stops
 * the run from reaching is left as it was. The call itself is not timed: the adapter bounds it.
 */
export async function probeConnections(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions,
  lockId: number,
  started: number
): Promise<void> {
  if (pastDeadline(deps, started)) return;

  const connections = await deps.store.transact(tx => tx.listConnections());

  for (const connection of connections) {
    if (pastDeadline(deps, started)) return;

    await probeConnection(deps, platforms, options, lockId, connection);
  }
}

async function probeConnection(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions,
  lockId: number,
  connection: ListedConnection
): Promise<void> {
  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'housekeeping',
    lockId,
    'probe',
    connection.id,
    connection.workspaceId
  );
  const failing = await connectionFailed(platforms, connection.id);

  await recordProbe(deps, lockId, connection, failing, plannedActionId);
}

async function connectionFailed(
  platforms: Platforms,
  connectionId: ConnectionId
): Promise<boolean> {
  try {
    const handle = platforms.require(connectionId);

    await handle.adapter.probe(handle.connection);

    return false;
  } catch (error) {
    if (error instanceof StoppedProcess) throw error;
    if (error instanceof HivemindError && error.code === 'conflict') throw error;

    if (error instanceof PlatformError) {
      console.error(
        `Housekeeping could not probe connection ${connectionId} (${error.errorClass}).`
      );

      return true;
    }

    console.error(`Housekeeping could not probe connection ${connectionId}.`, error);

    return true;
  }
}

async function recordProbe(
  deps: ServiceDeps,
  lockId: number,
  connection: ListedConnection,
  failing: boolean,
  plannedActionId: string
): Promise<void> {
  const now = formatTime(deps.clock.now());
  const held = await deps.store.transact(async tx => {
    if (!(await tx.holdJobLock('housekeeping', lockId, now))) return false;

    await tx.saveConnectionJobState({
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
      failing,
    });
    await saveConnectionAlert(deps, tx, connection, failing, now);

    if (!(await tx.finishPlannedAction(plannedActionId, 'housekeeping', lockId, now))) {
      throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
    }

    return true;
  });

  if (!held) throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
}

async function saveConnectionAlert(
  deps: ServiceDeps,
  tx: UnitOfWork,
  connection: ListedConnection,
  failing: boolean,
  now: string
): Promise<void> {
  const existing = await tx.openAlertByKey('connection_failing', connection.id);

  if (!failing) {
    if (existing !== null) await tx.clearAlert(existing.id, now);

    return;
  }

  if (existing !== null) {
    await tx.touchAlert(existing.id, now);

    return;
  }

  await tx.insertAlert({
    id: deps.ids.alert(),
    workspaceId: connection.workspaceId,
    groupId: null,
    rule: 'connection_failing',
    targetId: connection.id,
    severity: severityOf('connection_failing'),
    reason: null,
    openedAt: now,
    lastSeenAt: now,
    clearedAt: null,
    notifiedAt: null,
  });
}

function pastDeadline(deps: ServiceDeps, started: number): boolean {
  return deps.clock.now().getTime() - started > housekeepingDeadlineMs;
}
