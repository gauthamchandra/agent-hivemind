import { enforceLimits, knownQuestion } from '@/core/message-limits.ts';
import { recipientsFor } from '@/core/message-recipients.ts';
import { requireRoot } from '@/core/record-checks.ts';
import type { SendInput } from '@/core/send-message.ts';
import { lockTasksBeforeSession } from '@/core/session-lock.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, PersonId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type { Group, SessionRecord } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { requireAllowed } from '@/policy/policy.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

type SessionSender = { kind: 'session'; sessionId: SessionId };
type PersonSender = { kind: 'person'; personId: PersonId; administrator: boolean };

export type Draft = {
  groupId: GroupId;
  connectionId: Group['connection_id'];
  taskId: TaskId;
  senderRole: string;
  senderId: string;
  recipients: SessionRecord[];
};

export type HeldSend = {
  group: Group;
  sender: SessionRecord | null;
  senderId: string;
  senderRole: string;
};

/** Lock the group, then the sender. The caller replays a duplicate before mutable checks. */
export async function holdSend(tx: UnitOfWork, input: SendInput): Promise<HeldSend> {
  if (input.sender.kind === 'session') return holdSession(tx, input, input.sender);

  return holdPerson(tx, input, input.sender);
}

export async function finishDraft(
  tx: UnitOfWork,
  input: SendInput,
  held: HeldSend,
  nowMs: number
): Promise<Draft> {
  const taskId = await senderTask(tx, input, held);

  await knownQuestion(tx, input, held.group.id);
  await enforceLimits(tx, held.senderId, input, nowMs);

  return {
    groupId: held.group.id,
    connectionId: held.group.connection_id,
    taskId,
    senderRole: held.senderRole,
    senderId: held.senderId,
    recipients: await recipientsFor(tx, { ...input, groupId: held.group.id }, held.sender),
  };
}

async function holdSession(
  tx: UnitOfWork,
  input: SendInput,
  sender: SessionSender
): Promise<HeldSend> {
  const peeked = await tx.sessionById(sender.sessionId);

  if (peeked === null || peeked.workspace_id !== input.workspaceId) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  const group = await requireGroup(tx, input.workspaceId, peeked.group_id);

  await lockTasksBeforeSession(tx, peeked);

  const session = await tx.lockSession(input.workspaceId, sender.sessionId);

  if (session === null || session.token_hash === null || session.group_id !== group.id) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  if (session.life !== 'live' && session.life !== 'released') {
    throw new HivemindError('session_not_active', 'The session cannot act from this life.', {
      life: session.life,
    });
  }

  if (input.kind === 'instruction') {
    throw new HivemindError(
      'policy_denied',
      `The ${session.role} role cannot send an instruction.`,
      {
        role: session.role,
        action: 'send_instruction',
      }
    );
  }

  return { group, sender: session, senderId: session.id, senderRole: session.role };
}

async function holdPerson(
  tx: UnitOfWork,
  input: SendInput,
  sender: PersonSender
): Promise<HeldSend> {
  if (input.kind === 'relayed_instruction') {
    throw new HivemindError('validation_failed', 'A person sends an instruction, not a relay.', {
      field: 'kind',
    });
  }

  await tx.lockWorkspace(input.workspaceId);

  const group = await requireGroup(tx, input.workspaceId, await personGroup(tx, input));

  if (group.owner_person_id !== sender.personId && !sender.administrator) {
    throw new HivemindError('forbidden', 'Only the owner can send a message for this group.');
  }

  return { group, sender: null, senderId: sender.personId, senderRole: 'owner' };
}

async function senderTask(tx: UnitOfWork, input: SendInput, held: HeldSend): Promise<TaskId> {
  if (held.sender === null) return (await requireRoot(tx, input.workspaceId, held.group.id)).id;

  const root = await requireRoot(tx, input.workspaceId, held.sender.group_id);
  const task = await tx.lockTask(input.workspaceId, held.sender.task_id);

  if (task === null) throw new HivemindError('unavailable', 'The session task is missing.');

  requireAllowed({
    role: held.sender.role,
    action:
      input.audience === 'all' && input.kind !== 'relayed_instruction' ? 'send_all' : 'send_one',
    released: held.sender.life === 'released',
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: 'own',
    rootState: root.state,
    targetRole: held.sender.role,
    targetStartedByCaller: false,
    targetTaskClosed: isClosedState(task.state),
  });

  return held.sender.task_id;
}

async function personGroup(tx: UnitOfWork, input: SendInput): Promise<GroupId> {
  if (input.groupId !== undefined) return input.groupId;

  if (input.recipientId === undefined) {
    throw new HivemindError('validation_failed', 'An owner message names a group recipient.', {
      field: 'recipient_id',
    });
  }

  const recipient = await tx.sessionById(input.recipientId);

  if (recipient === null || recipient.workspace_id !== input.workspaceId) {
    throw new HivemindError(
      'recipient_not_available',
      'The recipient is ended or not in this group.'
    );
  }

  return recipient.group_id;
}

export function relayAudience(recipients: SessionRecord[]): 'one' | 'none' {
  return recipients.length === 0 ? 'none' : 'one';
}

async function requireGroup(tx: UnitOfWork, workspaceId: WorkspaceId, groupId: GroupId) {
  const group = await tx.lockGroup(workspaceId, groupId);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  return group;
}
