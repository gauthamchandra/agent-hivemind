import { appendEvent } from '@/core/append-event.ts';
import { settleRecipientMail } from '@/core/delivery.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { occupancyFor } from '@/core/session-caps.ts';
import { readFinalUsage, reclaimCompensatedStart } from '@/core/session-compensate.ts';
import { attachPlatformRef, recordEndIntent } from '@/core/session-intent.ts';
import { lockOwned } from '@/core/session-lock.ts';
import { endOnPlatform } from '@/core/session-platform.ts';
import { type CrashPoint, StoppedProcess } from '@/core/session-types.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { PersonId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function endSession(
  deps: ServiceDeps,
  platforms: Platforms,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    actor:
      | { kind: 'session'; sessionId: SessionId }
      | { kind: 'person'; personId: PersonId }
      | { kind: 'service' };
    reason: string;
    crashAt?: CrashPoint;
  }
): Promise<SessionRecord> {
  const prepared = await deps.store.transact(tx => recordEndIntent(deps, tx, input));

  if (prepared.finished) {
    if (prepared.session.life === 'start_failed') {
      return reclaimCompensatedStart(deps, platforms, prepared.session);
    }

    return settleEndedPlatform(deps, platforms, prepared.session);
  }

  if (input.crashAt === 'after_end_intent') throw new StoppedProcess('after_end_intent');

  return finishPlatformEnd(deps, platforms, prepared.session, input.crashAt);
}

export async function resumeEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  input: { workspaceId: WorkspaceId; sessionId: SessionId }
): Promise<SessionRecord> {
  const session = await deps.store.session(input.workspaceId, input.sessionId);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (session.life === 'ended') return settleEndedPlatform(deps, platforms, session);

  if (session.end_requested_at === null) {
    throw new HivemindError('conflict', 'The session has no ending intent.');
  }

  return finishPlatformEnd(deps, platforms, session, undefined);
}

/** Stop a platform session that appeared after the row was already ended, then read its usage. */
export async function settleEndedPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (session.life !== 'ended') return session;

  const current =
    session.platform_session_ref === null
      ? await attachPlatformRef(deps, platforms, session)
      : session;

  if (current.platform_session_ref === null) return current;
  if (!current.platform_stop_pending && !current.final_usage_pending) return current;

  if (current.platform_stop_pending) {
    await endOnPlatform(deps, platforms, current, current.platform_session_ref);
  }

  if (current.final_usage_pending) await readFinalUsage(deps, platforms, current);

  return (await deps.store.session(current.workspace_id, current.id)) ?? current;
}

export async function finishPlatformEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord,
  crashAt: CrashPoint | undefined
): Promise<SessionRecord> {
  const resolved =
    session.platform_session_ref === null
      ? await attachPlatformRef(deps, platforms, session)
      : session;

  if (resolved.platform_session_ref !== null) {
    await endOnPlatform(deps, platforms, resolved, resolved.platform_session_ref);
  }

  if (crashAt === 'after_platform_end') throw new StoppedProcess('after_platform_end');

  const finished = await deps.store.transact(tx => finishEnd(deps, tx, resolved));
  const attached = finished.platform_session_ref;

  if (attached !== null && attached !== resolved.platform_session_ref) {
    await endOnPlatform(deps, platforms, finished, attached);
  }

  if (finished.platform_session_ref !== null && finished.final_usage_pending) {
    await readFinalUsage(deps, platforms, finished);
  }

  return (await deps.store.session(finished.workspace_id, finished.id)) ?? finished;
}

async function finishEnd(
  deps: ServiceDeps,
  tx: UnitOfWork,
  current: SessionRecord
): Promise<SessionRecord> {
  const session = await lockOwned(tx, current.workspace_id, current.id);

  if (session.life === 'ended') return session;

  if (session.life === 'starting' || session.life === 'live') {
    await tx.addOccupancy(
      session.workspace_id,
      session.group_id,
      occupancyFor(session.role, -1, 0)
    );
  }

  const now = formatTime(deps.clock.now());
  const receiptHash = session.token_hash;

  session.life = 'ended';
  session.ended_at = now;
  session.token_hash = null;
  session.final_usage_pending = session.platform_session_ref !== null;
  await tx.updateSession(session);

  if (receiptHash !== null) {
    await tx.insertIdempotency({
      workspaceId: session.workspace_id,
      callerKind: 'end_receipt',
      callerId: receiptHash,
      route: 'session.end',
      key: 'token',
      bodyHash: receiptHash,
      recordId: session.id,
      completed: true,
      at: now,
    });
  }

  await tx.voidEnrollmentCodes(session.id, now);
  await settleRecipientMail(deps, tx, session.id);
  await appendEvent(deps, tx, {
    workspace_id: session.workspace_id,
    task_id: session.task_id,
    group_id: session.group_id,
    kind: 'session_ended',
    actor: {
      kind: session.end_actor_kind ?? 'service',
      id: session.end_actor_id ?? 'hivemind-svc',
    },
    from_state: null,
    to_state: null,
    evidence: [],
    note: session.end_reason,
    data: { session_id: session.id, reason: session.end_reason },
  });

  return session;
}
