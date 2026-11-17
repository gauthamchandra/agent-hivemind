import type { ServiceDeps } from '@/core/deps.ts';
import { rememberIdempotency, replayedRecord } from '@/core/record-checks.ts';
import { occupancyFor, reach } from '@/core/session-caps.ts';
import { refuseLiveCaps } from '@/core/session-gate.ts';
import { lockOwned } from '@/core/session-lock.ts';
import { storedSession } from '@/core/stored-response.ts';
import { compareDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function releaseSession(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    idempotency?: { key: string; bodyHash: string };
  }
): Promise<SessionRecord> {
  return deps.store.transact(async tx => {
    const session = await lockOwned(tx, input.workspaceId, input.sessionId);

    const released = await replayedLife(tx, session, 'session.release', input.idempotency);

    if (released) return released;

    if (session.life === 'starting') {
      throw new HivemindError('conflict', 'A session cannot release until its start completes.');
    }

    if (session.life !== 'live') {
      throw new HivemindError('session_not_active', 'The session cannot release from this life.', {
        life: session.life,
      });
    }

    const now = formatTime(deps.clock.now());

    await tx.addOccupancy(
      session.workspace_id,
      session.group_id,
      occupancyFor(session.role, -1, 0)
    );
    session.life = 'released';
    session.last_report_at = now;
    await tx.updateSession(session);
    await rememberLife(tx, session, 'session.release', input.idempotency, now);

    return session;
  });
}

export async function resumeSession(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    idempotency?: { key: string; bodyHash: string };
  }
): Promise<SessionRecord> {
  return deps.store.transact(async tx => {
    const session = await lockOwned(tx, input.workspaceId, input.sessionId);

    const resumed = await replayedLife(tx, session, 'session.resume', input.idempotency);

    if (resumed) return resumed;

    if (session.life !== 'released') {
      throw new HivemindError(
        'session_not_active',
        'Only a released session can become live again.',
        {
          life: session.life,
        }
      );
    }

    if (session.end_requested_at !== null) {
      throw new HivemindError('conflict', 'The session is already ending.');
    }

    const group = await tx.lockGroup(session.workspace_id, session.group_id);
    const workspace = await tx.lockWorkspace(session.workspace_id);

    if (group === null || workspace === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    if (group.status !== 'open') {
      throw new HivemindError('group_closed', 'The group accepts no new work.');
    }

    const occupancy = await tx.occupancy(session.workspace_id, session.group_id);
    const task = await tx.lockTask(session.workspace_id, session.task_id);

    if (task === null) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

    if (isClosedState(task.state)) {
      throw new HivemindError('conflict', 'The task is closed.');
    }

    if (compareDecimal(group.spend, group.budget) >= 0) {
      reach('budget', group.budget, group.spend);
    }

    refuseLiveCaps(
      group,
      workspace.limits.live_sessions,
      occupancy,
      session.role,
      await tx.liveOnTask(task.id, session.role)
    );
    const now = formatTime(deps.clock.now());

    session.life = 'live';
    session.last_report_at = now;
    await tx.addOccupancy(session.workspace_id, session.group_id, occupancyFor(session.role, 1, 0));
    await tx.updateSession(session);
    await rememberLife(tx, session, 'session.resume', input.idempotency, now);

    return session;
  });
}

async function replayedLife(
  tx: UnitOfWork,
  session: SessionRecord,
  route: string,
  idempotency: { key: string; bodyHash: string } | undefined
): Promise<SessionRecord | null> {
  const existing = await replayedRecord(
    tx,
    session.workspace_id,
    idempotency === undefined
      ? undefined
      : {
          key: idempotency.key,
          bodyHash: idempotency.bodyHash,
          callerKind: 'session',
          callerId: session.id,
          route,
        }
  );

  if (existing === null) return null;

  return storedSession(existing.response) ?? session;
}

async function rememberLife(
  tx: UnitOfWork,
  session: SessionRecord,
  route: string,
  idempotency: { key: string; bodyHash: string } | undefined,
  at: string
): Promise<void> {
  if (idempotency === undefined) return;

  await rememberIdempotency(
    tx,
    session.workspace_id,
    {
      key: idempotency.key,
      bodyHash: idempotency.bodyHash,
      callerKind: 'session',
      callerId: session.id,
      route,
    },
    session.id,
    at,
    { session: { ...session, token_hash: null } }
  );
}
