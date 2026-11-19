import type { ServiceDeps } from '@/core/deps.ts';
import {
  finishRecordedPlannedAction,
  type RunOptions,
  recordPlannedAction,
} from '@/core/job-run.ts';
import { applyReading } from '@/core/session-compensate.ts';
import type { JobSnapshot, SessionJobState } from '@/domain/background-jobs.ts';
import { isDeadStatus, sessionJobStateFor } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { Group, NeutralStatus, SessionRecord } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function recordPollResult(
  deps: ServiceDeps,
  input: {
    lockId: number;
    session: SessionRecord;
    status: NeutralStatus | null;
    reading: number | null;
    settlesFinalReading: boolean;
    jobState: SessionJobState;
  }
): Promise<{ usageGrew: boolean; spend: string | null }> {
  const now = formatTime(deps.clock.now());
  const result = await deps.store.transact(async tx => {
    if (!(await tx.holdJobLock('usage_poll', input.lockId, now))) return null;

    await tx.lockWorkspace(input.session.workspace_id);

    const group = await tx.lockGroup(input.session.workspace_id, input.session.group_id);
    const locked = await tx.lockSession(input.session.workspace_id, input.session.id);

    if (group === null || locked === null) return { usageGrew: false, spend: null };

    let usageGrew = false;

    if (input.reading !== null) {
      usageGrew = applyReading(group, locked, input.reading);

      if (usageGrew) {
        await tx.updateGroup(group);
        input.jobState.usageGrewAt = now;
      }

      input.session.usage = locked.usage;
    }

    if (input.status !== null) {
      locked.last_status = input.status;
      input.session.last_status = input.status;
    }

    if (input.settlesFinalReading && isClosed(locked) && locked.final_usage_pending) {
      locked.final_usage_pending = false;
    }

    await tx.updateSession(locked);
    await tx.saveSessionJobState(input.jobState, 'usage_poll');

    return { usageGrew, spend: group.spend };
  });

  if (result === null)
    throw new HivemindError('conflict', 'This worker no longer holds the job lock.');

  return result;
}

/**
 * Finish the planned action of a session that has left the snapshot. A session that is still in
 * the snapshot keeps its open action: its next poll reuses it, in the same rotating order as every
 * other session, so a session that keeps failing cannot hold up the others.
 */
export async function finishPollsOfGoneSessions(
  deps: ServiceDeps,
  snapshot: JobSnapshot,
  lockId: number
): Promise<void> {
  const plannedActions = await deps.store.transact(tx => tx.openPlannedActions('usage_poll'));
  const sessionIdsInSnapshot = new Set<string>(snapshot.sessions.map(session => session.id));

  for (const plannedAction of plannedActions) {
    if (plannedAction.action !== 'poll') continue;
    if (sessionIdsInSnapshot.has(plannedAction.targetId)) continue;

    await finishRecordedPlannedAction(deps, 'usage_poll', lockId, plannedAction.id);
  }
}

export async function pollSession(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  lockId: number,
  options: RunOptions,
  unreliable: Set<string>
): Promise<boolean> {
  const group = snapshot.groups.find(item => item.id === session.group_id);

  if (group === undefined || unreliable.has(group.connection_id)) return false;

  const plannedActionId = await recordPlannedAction(
    deps,
    options,
    'usage_poll',
    lockId,
    'poll',
    session.id,
    session.workspace_id
  );

  const grew = await readSession(deps, platforms, snapshot, session, group, lockId, unreliable);

  await finishRecordedPlannedAction(deps, 'usage_poll', lockId, plannedActionId);

  return grew;
}

async function readSession(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  session: SessionRecord,
  group: Group,
  lockId: number,
  unreliable: Set<string>
): Promise<boolean> {
  const jobState = sessionJobStateFor(snapshot, session);
  const now = formatTime(deps.clock.now());

  jobState.lastAttemptAt = now;
  await rememberAttempt(deps, lockId, jobState);

  const handle = platforms.require(group.connection_id);
  let status: NeutralStatus | null = null;
  let reading: number | null = null;
  let platformForgotSession = false;

  if (session.platform_session_ref !== null) {
    try {
      status = (await handle.adapter.readStatus(handle.connection, session.platform_session_ref))
        .status;
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      if (error.errorClass !== 'not_found') {
        markUnreliable(unreliable, group.connection_id, error);

        return false;
      }

      // A platform that forgot an ended session runs nothing for it. Without a status the session
      // would stay in every snapshot and be read on every run.
      if (session.life === 'ended') status = 'stopped';
    }

    if (handle.connection.capabilities.includes('usage_reading')) {
      try {
        reading = await handle.adapter.readUsage(handle.connection, session.platform_session_ref);

        if (!Number.isFinite(reading)) reading = ignoreUnreadableReading(session);
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        if (error.errorClass !== 'not_found') {
          markUnreliable(unreliable, group.connection_id, error);
        } else {
          platformForgotSession = true;
        }
      }
    }
  }

  if (status !== null) {
    jobState.badStatusStreak = isDeadStatus(status) ? jobState.badStatusStreak + 1 : 0;

    if (jobState.statusSince === null || session.last_status !== status) {
      jobState.statusSince = now;
    }
  }

  if (reading !== null) jobState.lastReadingAt = now;

  const previousUsage = session.usage;
  const result = await recordPollResult(deps, {
    lockId,
    session,
    status,
    reading,
    // A platform that no longer has the session cannot send the owed final reading, and it did not
    // report zero either, so the owed flag clears while usage and the last reading time stay as
    // they were.
    settlesFinalReading: owesFinalReading(session) && (reading !== null || platformForgotSession),
    jobState,
  });

  if (result.spend !== null) group.spend = result.spend;

  return result.usageGrew || (previousUsage !== null && session.usage !== previousUsage);
}

function ignoreUnreadableReading(session: SessionRecord): null {
  console.error(
    `Usage poll ignored an unreadable usage reading for session ${session.id}. Its status is still recorded.`,
    new Error('The platform sent a usage reading that is not a finite number.')
  );

  return null;
}

function owesFinalReading(session: SessionRecord): boolean {
  return isClosed(session) && session.final_usage_pending && !session.platform_stop_pending;
}

// A compensated start (see reclaimCompensatedStart) is a start_failed session that got a platform
// session after recovery gave its place back, so it owes a final reading just like an ended one.
function isClosed(session: SessionRecord): boolean {
  return session.life === 'ended' || session.life === 'start_failed';
}

async function rememberAttempt(
  deps: ServiceDeps,
  lockId: number,
  jobState: SessionJobState
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdJobLock('usage_poll', lockId, formatTime(deps.clock.now())))) return false;

    await tx.saveSessionJobState(jobState, 'usage_poll');

    return true;
  });

  if (!wrote) throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
}

function markUnreliable(unreliable: Set<string>, connectionId: string, error: PlatformError): void {
  unreliable.add(connectionId);
  console.warn(
    `Usage poll could not read connection ${connectionId} (${error.errorClass}). Skipping its other sessions until the next run.`
  );
}
