import type { ServiceDeps } from '@/core/deps.ts';
import { reclaimCompensatedStart } from '@/core/session-compensate.ts';
import { endSession } from '@/core/session-end.ts';
import { findOnPlatform } from '@/core/session-platform.ts';
import { recoverStart } from '@/core/session-start.ts';
import { finishRecordedIntent, type RunOptions, recordIntent } from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
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
  if (session.platform_session_ref === null) return false;

  const watch = watchFor(snapshot, session);

  if (!isDueForSuspension(deps, session, snapshot.waits, watch)) return false;
  if (isClosedState(task.state)) return false;

  const handle = platforms.require(group.connection_id);

  if (!handle.connection.capabilities.includes('wake_on_message')) return false;

  const current = await deps.store.session(session.workspace_id, session.id);
  const waitsNow = await deps.store.transact(tx =>
    tx.waitsInGroup(session.workspace_id, session.group_id)
  );

  if (current === null || !isDueForSuspension(deps, current, waitsNow, watch)) return false;

  const progress = current.last_report_at ?? current.created_at;
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

function isDueForSuspension(
  deps: ServiceDeps,
  session: SessionRecord,
  waits: WaitRecord[],
  watch: SessionWatch
): boolean {
  if (session.life !== 'live' && session.life !== 'released') return false;
  if (session.end_requested_at !== null) return false;
  if (session.last_status === 'waiting_for_person' || session.last_status === 'stopped') {
    return false;
  }

  const now = deps.clock.now().getTime();
  const progress = session.last_report_at ?? session.created_at;
  const isWaiting = waits.some(
    wait =>
      wait.waiting_session_id === session.id &&
      wait.cleared_at === null &&
      Date.parse(wait.deadline_at) > now
  );

  return (
    !isWaiting &&
    now - Date.parse(progress) >= suspendIdleMs &&
    watch.suspendedProgressAt !== progress
  );
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
    await recoverStart(
      deps,
      platforms,
      { workspaceId: session.workspace_id, sessionId: session.id },
      found
    );
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
  snapshot: FleetSnapshot,
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
    if (isPlatformStopFailure(error)) {
      await noteEndAttempt(deps, snapshot, session, epoch, error);
      return;
    }

    throw error;
  }
}

// endOnPlatform turns a PlatformError into HivemindError('unavailable'), so that is what a failed stop raises.
export function isPlatformStopFailure(error: unknown): boolean {
  return error instanceof HivemindError && error.code === 'unavailable';
}

export async function noteEndAttempt(
  deps: ServiceDeps,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  cause: unknown
): Promise<void> {
  const watch = watchFor(snapshot, session);

  watch.endAttemptRuns += 1;
  watch.endUnconfirmedRuns += 1;
  await writeReaperWatch(deps, epoch, watch);
  console.warn(
    `The platform did not stop session ${session.id}. The reaper tries it again on its next run.`,
    cause
  );
}

/** Write reaper columns only while this epoch still holds the reaper lease. */
export async function writeReaperWatch(
  deps: ServiceDeps,
  epoch: number,
  watch: SessionWatch
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('reaper', epoch, formatTime(deps.clock.now())))) return false;

    await tx.saveWatch(watch);

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
