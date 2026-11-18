import type { ServiceDeps } from '@/core/deps.ts';
import { requireBoundedText, requireRoot } from '@/core/record-checks.ts';
import { lockOwned, randomText } from '@/core/session-lock.ts';
import { findOnPlatform } from '@/core/session-platform.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { PersonId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import { requireAllowed } from '@/policy/policy.ts';
import type { Platforms } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function recordEndIntent(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    actor:
      | { kind: 'session'; sessionId: SessionId }
      | { kind: 'person'; personId: PersonId }
      | { kind: 'service' };
    reason: string;
  }
): Promise<{ finished: boolean; session: SessionRecord }> {
  const reason = requireBoundedText(input.reason, 'reason', 4 * 1024);
  const session = await lockOwned(tx, input.workspaceId, input.sessionId);

  if (
    session.life === 'ended' &&
    input.actor.kind === 'session' &&
    input.actor.sessionId === session.id
  ) {
    return { finished: true, session };
  }

  await authorizeEnd(tx, input.workspaceId, session, input.actor);

  if (session.life === 'ended' || session.life === 'start_failed') {
    return { finished: true, session };
  }

  if (session.end_requested_at !== null) return { finished: false, session };

  const now = formatTime(deps.clock.now());

  session.end_requested_at = now;
  session.end_actor_kind = input.actor.kind;
  session.end_actor_id =
    input.actor.kind === 'session'
      ? input.actor.sessionId
      : input.actor.kind === 'person'
        ? input.actor.personId
        : 'hivemind-svc';
  session.end_reason = reason;
  session.end_operation_id = randomText(deps);
  await tx.updateSession(session);
  await tx.voidEnrollmentCodes(session.id, now);

  return { finished: false, session };
}

export async function attachPlatformRef(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  const found = await findOnPlatform(deps, platforms, session);

  if (found.outcome === 'inconclusive') {
    throw new HivemindError('unavailable', 'The platform did not say whether the session exists.');
  }

  if (found.outcome === 'absent') return session;

  return deps.store.transact(async tx => {
    const locked = await lockOwned(tx, session.workspace_id, session.id);

    if (locked.platform_session_ref === null) {
      locked.platform_session_ref = found.platformSessionRef;
      locked.platform_address = found.address;

      if (locked.life === 'ended') {
        locked.final_usage_pending = true;
        locked.platform_stop_pending = true;
      }

      await tx.updateSession(locked);
    }

    return locked;
  });
}

async function authorizeEnd(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  target: SessionRecord,
  actor:
    | { kind: 'session'; sessionId: SessionId }
    | { kind: 'person'; personId: PersonId }
    | { kind: 'service' }
): Promise<void> {
  const task = await tx.lockTask(workspaceId, target.task_id);

  if (task === null) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  if (actor.kind === 'service') return;

  if (actor.kind === 'person') {
    const person = await tx.person(workspaceId, actor.personId);
    const group = await tx.lockGroup(workspaceId, target.group_id);

    if (person === null || group === null) {
      throw new HivemindError('forbidden', 'That person cannot end the session.');
    }

    if (person.id !== group.owner_person_id && person.workspace_role !== 'administrator') {
      throw new HivemindError(
        'forbidden',
        'Only the owner or an administrator can end the session.'
      );
    }

    return;
  }

  if (actor.sessionId === target.id) {
    requireAllowed({
      role: target.role,
      action: 'end_self',
      released: target.life === 'released',
      taskKind: task.parent_id === null ? 'root' : 'child',
      taskState: task.state,
      relation: 'own',
      rootState:
        task.parent_id === null
          ? task.state
          : (await requireRoot(tx, workspaceId, target.group_id)).state,
      targetRole: target.role,
      targetStartedByCaller: false,
      targetTaskClosed: isClosedState(task.state),
    });

    return;
  }

  const caller = await tx.lockSession(workspaceId, actor.sessionId);

  if (caller === null || caller.group_id !== target.group_id) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (caller.life !== 'live' && caller.life !== 'starting') {
    throw new HivemindError(
      'session_not_active',
      'The session cannot end a member from this life.',
      {
        life: caller.life,
      }
    );
  }

  const root = await requireRoot(tx, workspaceId, target.group_id);

  requireAllowed({
    role: caller.role,
    action: 'end_other',
    released: false,
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: caller.task_id === target.task_id ? 'own' : 'other',
    rootState: root.state,
    targetRole: target.role,
    targetStartedByCaller: target.parent_session_id === caller.id,
    targetTaskClosed: isClosedState(task.state),
  });
}
