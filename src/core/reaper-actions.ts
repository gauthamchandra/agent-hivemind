import type { ServiceDeps } from '@/core/deps.ts';
import {
  finishRecordedPlannedAction,
  type RunOptions,
  recordPlannedAction,
} from '@/core/job-run.ts';
import { reclaimCompensatedStart } from '@/core/session-compensate.ts';
import { endSession } from '@/core/session-end.ts';
import { findOnPlatform } from '@/core/session-platform.ts';
import { recoverStart } from '@/core/session-start.ts';
import type { JobSnapshot, SessionJobState } from '@/domain/background-jobs.ts';
import {
  emptySessionJobState,
  searchWindowMs,
  startingResolveMs,
  suspendIdleMs,
} from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function suspendIdle(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  task: Task,
  lockId: number,
  options: RunOptions
): Promise<boolean> {
  const group = snapshot.groups.find(item => item.id === session.group_id);

  if (group === undefined) return false;
  if (session.platform_session_ref === null) return false;

  const jobState = sessionJobStateFor(snapshot, session);

  if (!isDueForSuspension(deps, session, snapshot.waits, jobState)) return false;
  if (isClosedState(task.state)) return false;

  const handle = platforms.require(group.connection_id);

  if (!handle.connection.capabilities.includes('wake_on_message')) return false;

  const current = await deps.store.session(session.workspace_id, session.id);
  const waitsNow = await deps.store.transact(tx =>
    tx.waitsInGroup(session.workspace_id, session.group_id)
  );

  if (current === null || !isDueForSuspension(deps, current, waitsNow, jobState)) return false;

  const progress = current.last_report_at ?? current.created_at;
  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
    'suspend',
    session.id,
    session.workspace_id
  );

  await handle.adapter.suspend(handle.connection, session.platform_session_ref);
  jobState.suspendedAt = formatTime(deps.clock.now());
  jobState.suspendedProgressAt = progress;
  await writeReaperJobState(deps, lockId, jobState);
  await finishRecordedPlannedAction(deps, 'reaper', lockId, plannedActionId);

  return true;
}

function isDueForSuspension(
  deps: ServiceDeps,
  session: SessionRecord,
  waits: WaitRecord[],
  jobState: SessionJobState
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
    jobState.suspendedProgressAt !== progress
  );
}

export async function resolveStart(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
  options: RunOptions
): Promise<void> {
  if (session.life !== 'starting') return;

  const age = deps.clock.now().getTime() - Date.parse(session.created_at);

  if (age < startingResolveMs) return;

  const jobStateBefore = sessionJobStateFor(snapshot, session);
  const compensateLater =
    jobStateBefore.lastFind === 'absent' &&
    session.existence_evidence_at === null &&
    age <= searchWindowMs;

  if (jobStateBefore.lastFind === 'absent' && !compensateLater) return;

  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
    'resolve_start',
    session.id,
    session.workspace_id
  );
  const found = await findOnPlatform(deps, platforms, session);
  const jobState = sessionJobStateFor(snapshot, session);

  jobState.lastFind = found.outcome;
  jobState.inconclusiveRuns = found.outcome === 'inconclusive' ? jobState.inconclusiveRuns + 1 : 0;
  await writeReaperJobState(deps, lockId, jobState);

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

  await finishRecordedPlannedAction(deps, 'reaper', lockId, plannedActionId);
}
export async function noteOrphan(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
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

  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
    'orphan',
    session.id,
    session.workspace_id
  );
  const after = await reclaimCompensatedStart(deps, platforms, session);

  if (after.platform_session_ref !== null && session.platform_session_ref === null) {
    const jobState = sessionJobStateFor(snapshot, session);

    jobState.orphanEnded = true;
    await writeReaperJobState(deps, lockId, jobState);
  }

  await finishRecordedPlannedAction(deps, 'reaper', lockId, plannedActionId);
}

export async function endFor(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
  options: RunOptions,
  reason: string
): Promise<void> {
  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
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
    await finishRecordedPlannedAction(deps, 'reaper', lockId, plannedActionId);
  } catch (error) {
    if (isPlatformStopFailure(error)) {
      await noteEndAttempt(deps, snapshot, session, lockId, error);
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
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
  cause: unknown
): Promise<void> {
  const jobState = sessionJobStateFor(snapshot, session);

  jobState.endAttemptRuns += 1;
  jobState.endUnconfirmedRuns += 1;
  await writeReaperJobState(deps, lockId, jobState);
  console.warn(
    `The platform did not stop session ${session.id}. The reaper tries it again on its next run.`,
    cause
  );
}

/** Write the reaper's state only while this lock id still holds the reaper's job lock. */
export async function writeReaperJobState(
  deps: ServiceDeps,
  lockId: number,
  jobState: SessionJobState
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdJobLock('reaper', lockId, formatTime(deps.clock.now())))) return false;

    await tx.saveSessionJobState(jobState);

    return true;
  });

  if (!wrote) throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
}
export function sessionJobStateFor(snapshot: JobSnapshot, session: SessionRecord): SessionJobState {
  const found = snapshot.sessionJobStates.find(state => state.sessionId === session.id);

  if (found !== undefined) return found;

  const created = emptySessionJobState(session.id, session.workspace_id);

  snapshot.sessionJobStates.push(created);

  return created;
}
