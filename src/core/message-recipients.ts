import type { SendInput } from '@/core/send-message.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type { SessionRecord, SessionRole } from '@/domain/model.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function recipientsFor(
  tx: UnitOfWork,
  input: SendInput,
  sender: SessionRecord | null
): Promise<SessionRecord[]> {
  const groupId = sender?.group_id ?? input.groupId;

  if (input.kind === 'relayed_instruction' && sender !== null) return relayTo(tx, sender);

  if (input.audience === 'all') return everyOtherMember(tx, input, sender, groupId);

  if (input.recipientId !== undefined) return [await namedRecipient(tx, input, sender)];

  if (input.role !== undefined && input.taskId !== undefined && groupId !== undefined) {
    const found = await roleRecipient(tx, input.workspaceId, groupId, input.role, input.taskId);

    if (sender !== null && found.id === sender.id) {
      throw new HivemindError(
        'recipient_not_available',
        'The recipient is ended or not in this group.'
      );
    }

    return [found];
  }

  throw new HivemindError('validation_failed', 'The message needs a recipient.', {
    field: 'recipient_id',
  });
}

export async function namedRecipient(
  tx: UnitOfWork,
  input: SendInput,
  sender: SessionRecord | null
): Promise<SessionRecord> {
  const recipientId = input.recipientId;

  if (recipientId === undefined) {
    throw new HivemindError('validation_failed', 'The message needs a recipient.', {
      field: 'recipient_id',
    });
  }

  const recipient = await tx.lockSession(input.workspaceId, recipientId);
  const expectedGroup = sender?.group_id ?? input.groupId;
  const sameGroup = expectedGroup !== undefined && recipient?.group_id === expectedGroup;
  const unavailable =
    recipient === null ||
    !sameGroup ||
    recipient.life === 'ended' ||
    recipient.life === 'start_failed' ||
    recipient.id === sender?.id;

  if (unavailable || recipient === null) {
    throw new HivemindError(
      'recipient_not_available',
      'The recipient is ended or not in this group.'
    );
  }

  return recipient;
}

async function roleRecipient(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  groupId: GroupId,
  role: SessionRole,
  taskId: TaskId
): Promise<SessionRecord> {
  const matches = (await tx.groupSessions(workspaceId, groupId)).filter(
    session => session.role === role && session.task_id === taskId && canReceive(session)
  );
  const found = matches[0];

  if (found === undefined) {
    throw new HivemindError(
      'recipient_not_available',
      'The recipient is ended or not in this group.'
    );
  }

  if (matches.length > 1) {
    throw new HivemindError(
      'validation_failed',
      'More than one session holds that role on the task.',
      {
        field: 'role',
      }
    );
  }

  return found;
}

async function relayTo(tx: UnitOfWork, sender: SessionRecord): Promise<SessionRecord[]> {
  const sessions = await tx.groupSessions(sender.workspace_id, sender.group_id);
  const parent = sessions.find(
    session => session.id === sender.parent_session_id && canReceive(session)
  );

  if (parent !== undefined) return [parent];

  const planner = sessions.find(
    session => session.role === 'planner' && session.id !== sender.id && canReceive(session)
  );

  return planner === undefined ? [] : [planner];
}

async function everyOtherMember(
  tx: UnitOfWork,
  input: SendInput,
  sender: SessionRecord | null,
  groupId: GroupId | undefined
): Promise<SessionRecord[]> {
  if (groupId === undefined) return [];

  const others = (await tx.groupSessions(input.workspaceId, groupId)).filter(
    session => session.id !== sender?.id
  );

  if (others.some(session => !canReceive(session))) {
    throw new HivemindError(
      'recipient_not_available',
      'The recipient is ended or not in this group.'
    );
  }

  return others;
}

function canReceive(session: SessionRecord): boolean {
  return session.life === 'live' || session.life === 'released';
}
