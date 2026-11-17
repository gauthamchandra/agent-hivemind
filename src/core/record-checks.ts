import { storedTask, storedTransition } from '@/core/stored-response.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, PersonId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import { requireGroupId, requireTaskId } from '@/domain/ids.ts';
import type { ActorKind, Group, Person, SessionLife, SessionRecord, Task } from '@/domain/model.ts';
import type { IdempotencyRecord, UnitOfWork } from '@/ports/storage.ts';

export const serviceId = 'hivemind-svc';

export type StoredActor = { kind: ActorKind; id: string };

export type IdempotencyInput = {
  key: string;
  bodyHash: string;
  callerKind: string;
  callerId: string;
  route: string;
};

export async function replayedGroup(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput | undefined
): Promise<{ group: Group; root: Task; replay: true } | null> {
  const existing = await replayedRecord(tx, workspaceId, idempotency);

  if (existing === null) return null;

  const saved = storedTransition(existing.response);

  if (saved) return { group: saved.group, root: saved.task, replay: true };

  const recordId = existing.record_id;

  if (recordId === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const group = await tx.lockGroup(workspaceId, requireGroupId(recordId));

  if (group === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const root = await requireRoot(tx, workspaceId, group.id);

  return { group, root, replay: true };
}

export async function replayedTask(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput | undefined
): Promise<Task | null> {
  const existing = await replayedRecord(tx, workspaceId, idempotency);

  if (existing === null) return null;

  const saved = storedTask(existing.response);

  if (saved) return saved;

  const recordId = existing.record_id;

  if (recordId === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const task = await tx.lockTask(workspaceId, requireTaskId(recordId));

  if (task === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  return task;
}

export async function replayedRecord(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput | undefined
): Promise<IdempotencyRecord | null> {
  if (idempotency === undefined) return null;

  const existing = await tx.findIdempotency(
    workspaceId,
    idempotency.callerKind,
    idempotency.callerId,
    idempotency.route,
    idempotency.key
  );

  if (existing === null) return null;

  if (existing.body_hash !== idempotency.bodyHash) {
    throw new HivemindError(
      'idempotency_conflict',
      'That idempotency key was used with a different body.'
    );
  }

  return existing;
}

export async function rememberIdempotency(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput,
  recordId: string,
  at: string,
  response: unknown = {}
): Promise<void> {
  await tx.insertIdempotency({
    workspaceId,
    callerKind: idempotency.callerKind,
    callerId: idempotency.callerId,
    route: idempotency.route,
    key: idempotency.key,
    bodyHash: idempotency.bodyHash,
    recordId,
    completed: true,
    response,
    at,
  });
}

export async function requireGroup(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  groupId: GroupId
): Promise<Group> {
  const group = await tx.lockGroup(workspaceId, groupId);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  return group;
}

export async function requireTask(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  taskId: TaskId,
  groupId: GroupId
): Promise<Task> {
  const task = await tx.lockTask(workspaceId, taskId);

  if (task === null || task.group_id !== groupId) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  return task;
}

export async function requireRoot(
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

const actingLives = ['ended', 'start_failed'] as const;

export function refuseInactiveSession(
  session: SessionRecord,
  blocked: { lives: readonly SessionLife[]; message: string } = {
    lives: actingLives,
    message: 'The session cannot act from this life.',
  }
): void {
  if (session.token_hash === null) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  if (blocked.lives.includes(session.life)) {
    throw new HivemindError('session_not_active', blocked.message, { life: session.life });
  }

  if (session.end_requested_at !== null) {
    throw new HivemindError(
      'session_not_active',
      'The session is ending and cannot start new work.',
      { life: session.life }
    );
  }
}

/** Lock the caller. A missing row is not a credential. */
export async function lockedCaller(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<SessionRecord | null> {
  const session = await tx.lockSession(workspaceId, sessionId);

  if (session === null) return null;

  refuseInactiveSession(session);

  return session;
}

export async function requireLiveCaller(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<SessionRecord> {
  const session = await lockedCaller(tx, workspaceId, sessionId);

  if (session === null) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  return session;
}

export async function requireActivePerson(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  personId: PersonId
): Promise<Person> {
  const person = await tx.person(workspaceId, personId);

  if (person === null) {
    throw new HivemindError('not_found', 'No person with that identifier is in this workspace.');
  }

  if (person.status !== 'active') {
    throw new HivemindError('forbidden', 'That person is disabled.');
  }

  return person;
}

export function requireGroupName(name: string): string {
  const words = name.split(/\s+/).filter(word => word.length > 0);

  if (name.length < 1 || name.length > 40 || words.length < 1 || words.length > 5) {
    throw new HivemindError(
      'validation_failed',
      'A group name is 1 to 5 words and at most 40 characters.',
      {
        field: 'name',
      }
    );
  }

  return name;
}

export function requireTitle(title: string): string {
  if (title.trim().length === 0 || title.length > 120) {
    throw new HivemindError('validation_failed', 'A task title is 1 to 120 characters.', {
      field: 'title',
    });
  }

  return title;
}

export function requireBoundedText(value: string, field: string, maxBytes: number): string {
  if (value.trim().length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new HivemindError('validation_failed', `The ${field} is missing or too long.`, { field });
  }

  return value;
}
