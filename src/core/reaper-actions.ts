import type { ServiceDeps } from '@/core/deps.ts';
import { reclaimCompensatedStart } from '@/core/session-compensate.ts';
import { endSession } from '@/core/session-end.ts';
import { findOnPlatform } from '@/core/session-platform.ts';
import { recoverStart } from '@/core/session-start.ts';
import { finishRecordedIntent, type RunOptions, recordIntent } from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { FleetSnapshot, SessionWatch } from '@/domain/supervision.ts';
import {
  emptyWatch,
  searchWindowMs,
  startingResolveMs,
  suspendIdleMs,
} from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function suspendIdle(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  task: Task,
  epoch: number,
  options: RunOptions
): Promise<boolean> {
  const group = snapshot.groups.find(item => item.id === session.group_id);

  if (group === undefined) return false;
  if (session.life !== 'live' && session.life !== 'released') return false;
  if (session.platform_session_ref === null) return false;

  const handle = platforms.require(group.connection_id);

  if (!handle.connection.capabilities.includes('wake_on_message')) return false;
  if (session.last_status === 'waiting_for_person' || session.last_status === 'stopped')
    return false;
  if (isClosedState(task.state)) return false;

  const progress = session.last_report_at ?? session.created_at;
  const waiting = snapshot.waits.some(
    wait =>
      wait.waiting_session_id === session.id &&
      Date.parse(wait.deadline_at) > deps.clock.now().getTime()
  );
  const watch = watchFor(snapshot, session);

  if (waiting) return false;
  if (deps.clock.now().getTime() - Date.parse(progress) < suspendIdleMs) return false;
  if (watch.suspendedProgressAt === progress) return false;

  const intentId = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'suspend',
    session.id,
    session.workspace_id
  );

  await handle.adapter.suspend(handle.connection, session.platform_session_ref);
  watch.suspendedAt = formatTime(deps.clock.now());
  watch.suspendedProgressAt = progress;
  await writeReaperWatch(deps, epoch, watch);
  await finishRecordedIntent(deps, 'reaper', epoch, intentId);

  return true;
}
export async function resolveStart(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  options: RunOptions
): Promise<void> {
  if (session.life !== 'starting') return;

  const age = deps.clock.now().getTime() - Date.parse(session.created_at);

  if (age < startingResolveMs) return;

  const watched = watchFor(snapshot, session);
  const compensateLater =
    watched.lastFind === 'absent' &&
    session.existence_evidence_at === null &&
    age <= searchWindowMs;

  if (watched.lastFind === 'absent' && !compensateLater) return;

  const intentId = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'resolve_start',
    session.id,
    session.workspace_id
  );
  const found = await findOnPlatform(deps, platforms, session);
  const watch = watchFor(snapshot, session);

  watch.lastFind = found.outcome;
  watch.inconclusiveRuns = found.outcome === 'inconclusive' ? watch.inconclusiveRuns + 1 : 0;
  await writeReaperWatch(deps, epoch, watch);

  const compensate =
    found.outcome === 'absent' && session.existence_evidence_at === null && age <= searchWindowMs;

  if (found.outcome === 'found' || compensate) {
    await recoverStart(deps, platforms, {
      workspaceId: session.workspace_id,
      sessionId: session.id,
    });
  }

  await finishRecordedIntent(deps, 'reaper', epoch, intentId);
}
export async function noteOrphan(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  options: RunOptions
): Promise<void> {
  if (session.life !== 'start_failed') return;
  if (
    session.platform_session_ref !== null &&
    !session.final_usage_pending &&
    !session.platform_stop_pending
  ) {
    return;
  }
  if (
    session.platform_session_ref === null &&
    deps.clock.now().getTime() - Date.parse(session.created_at) > searchWindowMs
  ) {
    return;
  }

  const intentId = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'orphan',
    session.id,
    session.workspace_id
  );
  const after = await reclaimCompensatedStart(deps, platforms, session);

  if (after.platform_session_ref !== null && session.platform_session_ref === null) {
    const watch = watchFor(snapshot, session);

    watch.orphanEnded = true;
    await writeReaperWatch(deps, epoch, watch);
  }

  await finishRecordedIntent(deps, 'reaper', epoch, intentId);
}

export async function endFor(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord,
  epoch: number,
  options: RunOptions,
  reason: string
): Promise<void> {
  const intentId = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'end',
    session.id,
    session.workspace_id
  );

  try {
    await endSession(deps, platforms, {
      workspaceId: session.workspace_id,
      sessionId: session.id,
      actor: { kind: 'service' },
      reason,
    });
    await finishRecordedIntent(deps, 'reaper', epoch, intentId);
  } catch (error) {
    if (platformStopFailed(error)) {
      await noteEndAttempt(deps, session, epoch);
      return;
    }

    throw error;
  }
}

export function platformStopFailed(error: unknown): boolean {
  return (
    error instanceof PlatformError ||
    (error instanceof HivemindError && error.code === 'unavailable')
  );
}

export async function noteEndAttempt(
  deps: ServiceDeps,
  session: SessionRecord,
  epoch: number
): Promise<void> {
  const watch = emptyWatch(session.id, session.workspace_id);
  const current = await deps.store.transact(tx => tx.loadFleet());
  const existing = current.watches.find(item => item.sessionId === session.id) ?? watch;

  existing.endAttemptRuns += 1;
  existing.endUnconfirmedRuns += 1;
  await writeReaperWatch(deps, epoch, existing);
}

/** Write reaper columns only while this epoch still holds the reaper lease. */
export async function writeReaperWatch(
  deps: ServiceDeps,
  epoch: number,
  watch: SessionWatch
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('reaper', epoch, formatTime(deps.clock.now())))) return false;

    await tx.saveWatch(watch, 'reaper');

    return true;
  });

  if (!wrote) throw new HivemindError('conflict', 'The lease epoch is no longer current.');
}
export function watchFor(snapshot: FleetSnapshot, session: SessionRecord): SessionWatch {
  const found = snapshot.watches.find(watch => watch.sessionId === session.id);

  if (found !== undefined) return found;

  const created = emptyWatch(session.id, session.workspace_id);

  snapshot.watches.push(created);

  return created;
}
