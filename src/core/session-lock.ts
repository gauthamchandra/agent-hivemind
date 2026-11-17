import type { ServiceDeps } from '@/core/deps.ts';
import { requireRoot } from '@/core/record-checks.ts';
import type { StartInput } from '@/core/session-types.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord, SessionRole } from '@/domain/model.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

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
  await requireRoot(tx, workspaceId, peeked.group_id);

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

export function callerOf(input: StartInput): { kind: 'person' | 'session'; id: string } {
  if (input.actor.kind === 'person') return { kind: 'person', id: input.actor.personId };

  return { kind: 'session', id: input.actor.sessionId };
}

export function roleLabel(role: SessionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function randomText(deps: ServiceDeps): string {
  return Buffer.from(deps.random.bytes(16)).toString('base64url');
}
