import { appendEvent } from '@/core/append-event.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { type Draft, finishDraft, holdSend, relayAudience } from '@/core/message-directory.ts';
import { rememberIdempotency, replayedRecord } from '@/core/record-checks.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, MessageId, PersonId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import { requireMessageId } from '@/domain/ids.ts';
import type { MessageKind, MessageRecord, OutboxCopy, WaitRecord } from '@/domain/message.ts';
import {
  bodyLimit,
  defaultWaitSeconds,
  maxWaitSeconds,
  minWaitSeconds,
  redactCredentials,
} from '@/domain/message.ts';
import type { SessionRole } from '@/domain/model.ts';
import { isSessionRole } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

const sendRoute = 'message.send';

type SessionSender = { kind: 'session'; sessionId: SessionId };
type PersonSender = { kind: 'person'; personId: PersonId; administrator: boolean };

export type SendInput = {
  workspaceId: WorkspaceId;
  sender: SessionSender | PersonSender;
  kind: MessageKind;
  body: string;
  audience: 'one' | 'all';
  groupId?: GroupId;
  recipientId?: SessionId;
  role?: SessionRole;
  taskId?: TaskId;
  inReplyTo?: MessageId;
  recordWait?: boolean;
  waitSeconds?: number;
  idempotencyKey: string;
  bodyHash: string;
};

export type SentMessage = { message: MessageRecord; copies: OutboxCopy[]; wait: WaitRecord | null };

export async function sendMessage(deps: ServiceDeps, input: SendInput): Promise<SentMessage> {
  validateSend(input);

  return deps.store.transact(tx => acceptMessage(deps, tx, input));
}

async function acceptMessage(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: SendInput
): Promise<SentMessage> {
  const callerId = input.sender.kind === 'session' ? input.sender.sessionId : input.sender.personId;
  const idempotency = {
    key: input.idempotencyKey,
    bodyHash: input.bodyHash,
    callerKind: input.sender.kind,
    callerId,
    route: sendRoute,
  };
  const replay = await replayedRecord(tx, input.workspaceId, idempotency);

  if (replay !== null) return replayedSend(tx, replay);

  const held = await holdSend(tx, input);
  const raced = await replayedRecord(tx, input.workspaceId, idempotency);

  if (raced !== null) return replayedSend(tx, raced);

  const nowMs = deps.clock.now().getTime();
  const now = formatTime(new Date(nowMs));

  const draft = await finishDraft(tx, input, held, nowMs);
  const audience =
    input.kind === 'relayed_instruction' ? relayAudience(draft.recipients) : input.audience;
  const message: MessageRecord = {
    id: deps.ids.message(),
    workspace_id: input.workspaceId,
    group_id: draft.groupId,
    sender_kind: input.sender.kind,
    sender_id: callerId,
    sender_role: draft.senderRole,
    sender_task_id: draft.taskId,
    kind: input.kind,
    audience,
    in_reply_to: input.inReplyTo ?? null,
    body: redactCredentials(input.body),
    idempotency_key: input.idempotencyKey,
    created_at: now,
  };

  await tx.insertMessage(message);

  const copies = await writeCopies(deps, tx, message, draft, now);
  const wait = await writeWaits(deps, tx, input, message, draft, now, nowMs);

  if (input.kind === 'answer' && input.inReplyTo !== undefined && input.sender.kind === 'session') {
    await tx.clearQuestionWaits(input.inReplyTo, input.sender.sessionId, now);
  }

  await appendEvent(deps, tx, {
    workspace_id: input.workspaceId,
    task_id: draft.taskId,
    group_id: draft.groupId,
    kind: 'message',
    actor: { kind: input.sender.kind, id: callerId },
    from_state: null,
    to_state: null,
    evidence: [],
    note: null,
    data: {
      message_id: message.id,
      kind: message.kind,
      recipients: copies.map(copy => copy.recipient_id).join(','),
    },
  });

  if (input.sender.kind === 'session') await tx.touchReport(input.sender.sessionId, now);

  await rememberIdempotency(tx, input.workspaceId, idempotency, message.id, now, {
    wait_id: wait?.id ?? null,
  });

  return { message, copies, wait };
}

async function writeCopies(
  deps: ServiceDeps,
  tx: UnitOfWork,
  message: MessageRecord,
  draft: Draft,
  now: string
): Promise<OutboxCopy[]> {
  const copies: OutboxCopy[] = [];

  for (const recipient of draft.recipients) {
    const copy: OutboxCopy = {
      id: deps.ids.copy(),
      workspace_id: message.workspace_id,
      group_id: message.group_id,
      connection_id: draft.connectionId,
      message_id: message.id,
      recipient_id: recipient.id,
      sequence: await tx.nextCopySequence(recipient.id),
      claim_generation: 0,
      state: 'queued',
      attempts: 0,
      busy_streak: 0,
      next_attempt_at: now,
      claimed_by: null,
      claimed_until: null,
      outcome_reason: null,
      platform_reference: null,
      created_at: now,
      delivered_at: null,
    };

    await tx.insertCopy(copy);
    copies.push(copy);
  }

  return copies;
}

async function writeWaits(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: SendInput,
  message: MessageRecord,
  draft: Draft,
  now: string,
  nowMs: number
): Promise<WaitRecord | null> {
  const record = input.kind === 'question' ? input.recordWait !== false : input.recordWait === true;

  if (!record || input.sender.kind !== 'session') return null;

  const seconds = input.waitSeconds ?? defaultWaitSeconds;
  let first: WaitRecord | null = null;

  for (const recipient of draft.recipients) {
    const wait: WaitRecord = {
      id: deps.ids.wait(),
      workspace_id: message.workspace_id,
      group_id: message.group_id,
      waiting_session_id: input.sender.sessionId,
      awaited_session_id: recipient.id,
      question_id: input.kind === 'question' ? message.id : (input.inReplyTo ?? null),
      deadline_at: formatTime(new Date(nowMs + seconds * 1000)),
      created_at: now,
      cleared_at: null,
    };

    await tx.insertWait(wait);
    first ??= wait;
  }

  return first;
}

async function replayedSend(
  tx: UnitOfWork,
  replay: { record_id: string | null; response: unknown }
): Promise<SentMessage> {
  if (replay.record_id === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const message = await tx.loadMessage(requireMessageId(replay.record_id));

  if (message === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const copies = await tx.copiesOf(message.id);
  const savedWait = waitIdFrom(replay.response);
  const waits =
    savedWait === null ? [] : await tx.waitsInGroup(message.workspace_id, message.group_id);

  return {
    message,
    copies,
    wait: waits.find(wait => wait.id === savedWait) ?? null,
  };
}

function waitIdFrom(response: unknown): string | null {
  if (typeof response !== 'object' || response === null || !('wait_id' in response)) return null;

  const value = response.wait_id;

  return typeof value === 'string' ? value : null;
}

function validateSend(input: SendInput): void {
  if (input.body.trim().length === 0) {
    throw new HivemindError('validation_failed', 'The message body is empty.', { field: 'body' });
  }

  if (Buffer.byteLength(input.body) > bodyLimit) {
    throw new HivemindError('payload_too_large', 'The message body is too large.', {
      limit: bodyLimit,
    });
  }

  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 64) {
    throw new HivemindError(
      'validation_failed',
      'The idempotency key must be 1 to 64 characters.',
      {
        field: 'Idempotency-Key',
      }
    );
  }

  if (input.audience === 'one' && input.recipientId === undefined && input.role === undefined) {
    if (input.kind !== 'relayed_instruction') {
      throw new HivemindError('validation_failed', 'The message needs a recipient.', {
        field: 'recipient_id',
      });
    }
  }

  if (input.role !== undefined && !isSessionRole(input.role)) {
    throw new HivemindError('validation_failed', 'The role is not valid.', { field: 'role' });
  }

  if (
    input.waitSeconds !== undefined &&
    (input.waitSeconds < minWaitSeconds || input.waitSeconds > maxWaitSeconds)
  ) {
    throw new HivemindError('validation_failed', 'A wait is from 1 second to 24 hours.', {
      field: 'wait_seconds',
    });
  }
}
