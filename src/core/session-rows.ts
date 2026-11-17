import type { ServiceDeps } from '@/core/deps.ts';
import type { StartInput, StartOutcome } from '@/core/session-types.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord, SessionRole, Task } from '@/domain/model.ts';
import type { PlatformErrorClass } from '@/domain/platform.ts';
import type { OccupancyDelta, UnitOfWork } from '@/ports/storage.ts';

export async function lockOwned(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<SessionRecord> {
  const peeked = await tx.sessionById(sessionId);

  if (peeked === null || peeked.workspace_id !== workspaceId) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  await tx.lockWorkspace(workspaceId);
  await tx.lockGroup(workspaceId, peeked.group_id);
  await rootTask(tx, workspaceId, peeked.group_id);

  const task = await tx.lockTask(workspaceId, peeked.task_id);

  if (task === null) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  const session = await tx.lockSession(workspaceId, sessionId);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  return session;
}

export async function rootTask(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  groupId: GroupId
): Promise<Task> {
  const tasks = await tx.tasks(workspaceId, groupId);
  const root = tasks.find(task => task.parent_id === null);

  if (root === undefined) {
    throw new HivemindError('unavailable', 'The group has no root task.');
  }

  const locked = await tx.lockTask(workspaceId, root.id);

  if (locked === null) {
    throw new HivemindError('unavailable', 'The group has no root task.');
  }

  return locked;
}

export async function requireLiveCaller(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<SessionRecord> {
  const session = await tx.lockSession(workspaceId, sessionId);

  if (session === null || session.token_hash === null) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  if (session.life === 'ended' || session.life === 'start_failed') {
    throw new HivemindError('session_not_active', 'The session cannot act from this life.', {
      life: session.life,
    });
  }

  if (session.end_requested_at !== null) {
    throw new HivemindError(
      'session_not_active',
      'The session is ending and cannot start new work.',
      { life: session.life }
    );
  }

  return session;
}

export function callerOf(input: StartInput): { kind: 'person' | 'session'; id: string } {
  if (input.actor.kind === 'person') return { kind: 'person', id: input.actor.personId };

  return { kind: 'session', id: input.actor.sessionId };
}

export async function storedOutcome(
  deps: ServiceDeps,
  session: SessionRecord
): Promise<StartOutcome> {
  if (session.life !== 'start_failed') return outcomeFrom(session);

  const events = await deps.store.events(session.workspace_id, session.group_id);
  const failed = events.findLast(
    event => event.kind === 'session_start_failed' && event.data.session_id === session.id
  );
  const recorded = failed?.data.error_class;

  return {
    outcome: 'refused',
    session,
    errorClass: isPlatformErrorClass(recorded) ? recorded : 'invalid',
  };
}

export function isPlatformErrorClass(value: unknown): value is PlatformErrorClass {
  return (
    value === 'auth' ||
    value === 'rate_limited' ||
    value === 'quota' ||
    value === 'invalid' ||
    value === 'not_found' ||
    value === 'unavailable'
  );
}

/** A replay still has a platform stop or a usage read to finish. Other terminal rows do not. */
export function owesCleanup(session: SessionRecord): boolean {
  if (session.life === 'start_failed') return session.final_usage_pending;

  return (
    session.life === 'ended' &&
    (session.final_usage_pending || session.platform_session_ref === null)
  );
}

export function outcomeFrom(session: SessionRecord): StartOutcome {
  if (session.life === 'starting') return { outcome: 'start_pending', session };
  if (session.life === 'start_failed') {
    return { outcome: 'refused', session, errorClass: 'invalid' };
  }
  if (session.life === 'ended') return { outcome: 'ended', session };
  if (session.life === 'released') return { outcome: 'released', session };

  return { outcome: 'live', session };
}

export function occupancyFor(role: SessionRole, live: number, total: number): OccupancyDelta {
  return {
    live_sessions: live,
    planner: role === 'planner' ? live : 0,
    challenger: role === 'challenger' ? live : 0,
    implementer: role === 'implementer' ? live : 0,
    total_sessions: total,
  };
}

export function reach(cap: string, limit: number | string, current: number | string): never {
  throw new HivemindError(
    'cap_reached',
    `The ${cap} cap is ${limit}. The current value is ${current}.`,
    {
      cap,
      limit,
      current,
    }
  );
}

export function requireText(value: string, field: string, maxBytes: number): string {
  if (value.trim().length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new HivemindError('validation_failed', `The ${field} is missing or too long.`, { field });
  }

  return value;
}

export function roleLabel(role: SessionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function randomText(deps: ServiceDeps): string {
  return Buffer.from(deps.random.bytes(16)).toString('base64url');
}
