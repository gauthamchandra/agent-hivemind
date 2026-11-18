import type { ServiceDeps } from '@/core/deps.ts';
import { knownQuestion } from '@/core/message-limits.ts';
import { namedRecipient } from '@/core/message-recipients.ts';
import { requireRoot } from '@/core/record-checks.ts';
import type { SendInput } from '@/core/send-message.ts';
import { lockTasksBeforeSession } from '@/core/session-lock.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, MessageId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import { requireWaitId } from '@/domain/ids.ts';
import type { OutboxCopy, WaitRecord } from '@/domain/message.ts';
import { deliveredMeans, maxWaitSeconds, minWaitSeconds } from '@/domain/message.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import { requireAllowed } from '@/policy/policy.ts';

export function copiesFor(deps: ServiceDeps, messageId: MessageId): Promise<OutboxCopy[]> {
  return deps.store.transact(tx => tx.copiesOf(messageId));
}

export function waitsFor(deps: ServiceDeps, workspaceId: WorkspaceId, groupId: GroupId) {
  return deps.store.transact(tx => tx.waitsInGroup(workspaceId, groupId));
}

export async function listInbox(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    groupId: GroupId;
    sessionId: SessionId;
    kind: string | null;
    unanswered: boolean;
  }
) {
  const messages = await deps.store.transact(tx =>
    tx.inbox(input.workspaceId, input.groupId, input.sessionId, input.kind, input.unanswered)
  );

  return { delivered_means: deliveredMeans, messages };
}

export async function readMail(deps: ServiceDeps, workspaceId: WorkspaceId, groupId: GroupId) {
  const page = await deps.store.transact(async tx => {
    const group = await tx.lockGroup(workspaceId, groupId);

    if (group === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    return tx.mailPage(workspaceId, groupId);
  });
  const copiesByMessage = new Map<string, OutboxCopy[]>();

  for (const copy of page.copies) {
    const copies = copiesByMessage.get(copy.message_id) ?? [];

    copies.push(copy);
    copiesByMessage.set(copy.message_id, copies);
  }

  return {
    delivered_means: deliveredMeans,
    removed_count: page.removed,
    messages: page.messages.map(message => ({
      ...message,
      outcomes: (copiesByMessage.get(message.id) ?? []).map(copy => ({
        recipient_id: copy.recipient_id,
        state: copy.state === 'claimed' ? 'queued' : copy.state,
        reason: copy.outcome_reason,
      })),
    })),
  };
}

export async function recordWait(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    awaitedId: SessionId;
    seconds: number;
    questionId: MessageId | null;
  }
): Promise<WaitRecord> {
  validateWait(input.seconds);

  return deps.store.transact(async tx => {
    const peeked = await tx.sessionById(input.sessionId);

    if (peeked === null || peeked.workspace_id !== input.workspaceId) {
      throw new HivemindError('unauthenticated', 'The session token is not valid.');
    }

    const group = await tx.lockGroup(input.workspaceId, peeked.group_id);

    if (group === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    await lockTasksBeforeSession(tx, peeked);

    const session = await tx.lockSession(input.workspaceId, input.sessionId);

    if (session === null || session.group_id !== group.id) {
      throw new HivemindError('unauthenticated', 'The session token is not valid.');
    }

    if (session.life !== 'live' && session.life !== 'released') {
      throw new HivemindError('session_not_active', 'The session cannot act from this life.', {
        life: session.life,
      });
    }

    const root = await requireRoot(tx, input.workspaceId, session.group_id);
    const task = await tx.lockTask(input.workspaceId, session.task_id);

    if (task === null) throw new HivemindError('unavailable', 'The session task is missing.');

    requireAllowed({
      role: session.role,
      action: 'record_wait',
      released: session.life === 'released',
      taskKind: task.parent_id === null ? 'root' : 'child',
      taskState: task.state,
      relation: 'own',
      rootState: root.state,
      targetRole: session.role,
      targetStartedByCaller: false,
      targetTaskClosed: isClosedState(task.state),
    });

    const awaited = await namedRecipient(
      tx,
      { ...blank(input.workspaceId, session.id), recipientId: input.awaitedId },
      session
    );

    if (input.questionId !== null)
      await knownQuestion(
        tx,
        {
          ...blank(input.workspaceId, session.id),
          kind: 'answer',
          inReplyTo: input.questionId,
          audience: 'one',
        },
        session.group_id
      );

    const nowMs = deps.clock.now().getTime();
    const wait: WaitRecord = {
      id: deps.ids.wait(),
      workspace_id: input.workspaceId,
      group_id: session.group_id,
      waiting_session_id: session.id,
      awaited_session_id: awaited.id,
      question_id: input.questionId,
      deadline_at: formatTime(new Date(nowMs + input.seconds * 1000)),
      created_at: formatTime(new Date(nowMs)),
      cleared_at: null,
    };

    await tx.insertWait(wait);
    await tx.touchReport(session.id, wait.created_at);

    return wait;
  });
}

function blank(workspaceId: WorkspaceId, sessionId: SessionId): SendInput {
  return {
    workspaceId,
    sender: { kind: 'session', sessionId },
    kind: 'note',
    body: 'wait',
    audience: 'one',
    idempotencyKey: 'wait',
    bodyHash: 'wait',
  };
}

export async function clearNamedWait(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; sessionId: SessionId; waitId: string }
): Promise<WaitRecord> {
  return deps.store.transact(async tx => {
    const cleared = await tx.clearWait(
      requireWaitId(input.waitId),
      input.sessionId,
      formatTime(deps.clock.now())
    );

    if (cleared === null || cleared.workspace_id !== input.workspaceId) {
      throw new HivemindError('not_found', 'No wait with that identifier is in this workspace.');
    }

    await tx.touchReport(input.sessionId, formatTime(deps.clock.now()));

    return cleared;
  });
}

function validateWait(seconds: number): void {
  if (seconds < minWaitSeconds || seconds > maxWaitSeconds) {
    throw new HivemindError('validation_failed', 'A wait is from 1 second to 24 hours.', {
      field: 'wait_seconds',
    });
  }
}
