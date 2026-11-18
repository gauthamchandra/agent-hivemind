import { appendEvent } from '@/core/append-event.ts';
import { settleRecipientMail } from '@/core/delivery.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { occupancyFor } from '@/core/session-caps.ts';
import { reclaimCompensatedStart, stopCompensatedPlatform } from '@/core/session-compensate.ts';
import { finishPlatformEnd, settleEndedPlatform } from '@/core/session-end.ts';
import { outcomeFrom, owesCleanup, storedOutcome } from '@/core/session-outcome.ts';
import { findOnPlatform } from '@/core/session-platform.ts';
import { reserveStart } from '@/core/session-reserve.ts';
import {
  enrollmentTtlMs,
  type StartInput,
  type StartOutcome,
  StoppedProcess,
} from '@/core/session-types.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { isRefusal, PlatformError, type PlatformErrorClass } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { FindResult, Platforms, StartSessionResult } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

const startsInFlight = new Set<SessionId>();

export async function startSession(
  deps: ServiceDeps,
  platforms: Platforms,
  input: StartInput
): Promise<StartOutcome> {
  const reserved = await deps.store.transact(tx => reserveStart(deps, platforms, tx, input));

  if (reserved.replay) {
    return storedOutcome(deps, await recoverPendingStart(deps, platforms, reserved.session));
  }

  if (input.crashAt === 'after_reserve') throw new StoppedProcess('after_reserve');

  const handle = platforms.require(reserved.connectionId);

  startsInFlight.add(reserved.session.id);

  try {
    const started = await handle.adapter.start(handle.connection, reserved.platformInput);

    if (input.crashAt === 'after_platform_accept')
      throw new StoppedProcess('after_platform_accept');

    const session = await deps.store.transact(tx =>
      completeStart(deps, tx, reserved.session, reserved.startAttemptId, started)
    );

    if (session.end_requested_at !== null && session.life !== 'ended') {
      return outcomeFrom(await finishPlatformEnd(deps, platforms, session, undefined));
    }

    if (session.life === 'ended') {
      return outcomeFrom(await settleEndedPlatform(deps, platforms, session));
    }

    if (session.life !== 'live') {
      if (
        session.life === 'start_failed' &&
        (session.final_usage_pending || session.platform_stop_pending) &&
        session.platform_session_ref !== null
      ) {
        await stopCompensatedPlatform(deps, platforms, session);
      }

      return outcomeFrom((await deps.store.session(session.workspace_id, session.id)) ?? session);
    }

    return { outcome: 'live', session };
  } catch (error) {
    if (error instanceof StoppedProcess) throw error;

    if (error instanceof PlatformError && error.errorClass === 'unavailable') {
      const session =
        (await deps.store.session(input.workspaceId, reserved.session.id)) ?? reserved.session;

      if (session.life !== 'starting' || session.end_requested_at !== null) {
        if (session.end_requested_at !== null && session.life !== 'ended') {
          return outcomeFrom(await finishPlatformEnd(deps, platforms, session, undefined));
        }

        return outcomeFrom(session);
      }

      return { outcome: 'start_pending', session };
    }

    if (error instanceof PlatformError && isRefusal(error.errorClass)) {
      const current =
        (await deps.store.session(input.workspaceId, reserved.session.id)) ?? reserved.session;

      if (current.end_requested_at !== null || current.platform_session_ref !== null) {
        throw new HivemindError('unavailable', 'The platform did not stop the session.');
      }

      const session = await deps.store.transact(tx =>
        compensateStart(deps, tx, reserved.session, error.errorClass)
      );

      return { outcome: 'refused', session, errorClass: error.errorClass };
    }

    throw error;
  } finally {
    startsInFlight.delete(reserved.session.id);
  }
}

export async function recoverPendingStart(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (startsInFlight.has(session.id)) return session;
  if (session.life !== 'starting' && !owesCleanup(session)) return session;

  return recoverStart(deps, platforms, {
    workspaceId: session.workspace_id,
    sessionId: session.id,
  });
}

export async function recoverStart(
  deps: ServiceDeps,
  platforms: Platforms,
  input: { workspaceId: WorkspaceId; sessionId: SessionId },
  findOutcomeAlreadyKnown?: FindResult
): Promise<SessionRecord> {
  const current = await deps.store.session(input.workspaceId, input.sessionId);

  if (current === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (current.life !== 'starting') {
    if (current.life === 'ended') return settleEndedPlatform(deps, platforms, current);

    if (current.life === 'start_failed') {
      return reclaimCompensatedStart(deps, platforms, current);
    }

    return current;
  }

  const found = findOutcomeAlreadyKnown ?? (await findOnPlatform(deps, platforms, current));

  if (found.outcome === 'inconclusive') return current;

  if (found.outcome === 'absent') {
    if (current.end_requested_at !== null) {
      return finishPlatformEnd(deps, platforms, current, undefined);
    }

    if (current.existence_evidence_at !== null) return current;

    return deps.store.transact(tx => compensateStart(deps, tx, current, 'invalid'));
  }

  const completed = await deps.store.transact(tx =>
    completeStart(deps, tx, current, current.start_attempt_id, {
      platformSessionRef: found.platformSessionRef,
      address: found.address,
      attributedTo: 'service',
      secretDelivered: current.token_hash === null ? 'no' : 'yes',
    })
  );

  if (completed.end_requested_at !== null && completed.life !== 'ended') {
    return finishPlatformEnd(deps, platforms, completed, undefined);
  }

  if (completed.life === 'ended') return settleEndedPlatform(deps, platforms, completed);

  if (
    completed.life === 'start_failed' &&
    (completed.final_usage_pending || completed.platform_stop_pending) &&
    completed.platform_session_ref !== null
  ) {
    return stopCompensatedPlatform(deps, platforms, completed);
  }

  return completed;
}

async function completeStart(
  deps: ServiceDeps,
  tx: UnitOfWork,
  current: SessionRecord,
  startAttemptId: string,
  result: StartSessionResult
): Promise<SessionRecord> {
  await tx.lockWorkspace(current.workspace_id);
  await tx.lockGroup(current.workspace_id, current.group_id);
  const session = await tx.lockSession(current.workspace_id, current.id);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (session.end_requested_at !== null) {
    if (session.platform_session_ref === null) {
      session.platform_session_ref = result.platformSessionRef;
      session.platform_address = result.address;

      if (session.life === 'ended') {
        session.final_usage_pending = true;
        session.platform_stop_pending = true;
      }

      await tx.updateSession(session);
    }

    return session;
  }

  if (session.life !== 'starting' || session.start_attempt_id !== startAttemptId) {
    if (session.life === 'start_failed' && session.platform_session_ref === null) {
      session.platform_session_ref = result.platformSessionRef;
      session.platform_address = result.address;
      session.final_usage_pending = true;
      session.platform_stop_pending = true;
      await tx.updateSession(session);
    }

    return session;
  }

  session.life = 'live';
  session.platform_session_ref = result.platformSessionRef;
  session.platform_address = result.address;
  session.attributed_to = result.attributedTo;
  session.secret_delivered = result.secretDelivered;
  await tx.updateSession(session);

  const code = await tx.openEnrollmentCode(session.id);

  if (code !== null && code.expires_at === null) {
    code.expires_at = formatTime(new Date(deps.clock.now().getTime() + enrollmentTtlMs));
    await tx.saveEnrollmentCode(code);
  }

  return session;
}

async function compensateStart(
  deps: ServiceDeps,
  tx: UnitOfWork,
  current: SessionRecord,
  errorClass: PlatformErrorClass
): Promise<SessionRecord> {
  await tx.lockWorkspace(current.workspace_id);
  await tx.lockGroup(current.workspace_id, current.group_id);
  const session = await tx.lockSession(current.workspace_id, current.id);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (
    session.life !== 'starting' ||
    session.existence_evidence_at !== null ||
    session.end_requested_at !== null
  ) {
    return session;
  }

  const now = formatTime(deps.clock.now());

  session.life = 'start_failed';
  session.token_hash = null;
  await tx.updateSession(session);
  await tx.voidEnrollmentCodes(session.id, now);
  await settleRecipientMail(deps, tx, session.id);
  await tx.addOccupancy(session.workspace_id, session.group_id, occupancyFor(session.role, -1, 0));
  await appendEvent(deps, tx, {
    workspace_id: session.workspace_id,
    task_id: session.task_id,
    group_id: session.group_id,
    kind: 'session_start_failed',
    actor: { kind: 'service', id: 'hivemind-svc' },
    from_state: null,
    to_state: null,
    evidence: [],
    note: null,
    data: { session_id: session.id, error_class: errorClass },
  });

  return session;
}
