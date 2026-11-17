import type { SendInput } from '@/core/send-message.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId } from '@/domain/ids.ts';
import {
  broadcastLimit,
  broadcastWindowMs,
  openQuestionLimit,
  senderLimit,
  senderWindowMs,
} from '@/domain/message.ts';
import { formatTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function knownQuestion(
  tx: UnitOfWork,
  input: SendInput,
  groupId: GroupId
): Promise<void> {
  if (input.kind !== 'answer') return;

  const reply = input.inReplyTo;

  if (reply === undefined) {
    throw new HivemindError('validation_failed', 'An answer names the question.', {
      field: 'in_reply_to',
    });
  }

  const question = await tx.findMessage(input.workspaceId, groupId, reply);

  if (question === null) {
    throw new HivemindError('not_found', 'No message with that identifier is in this group.');
  }

  if (question.kind !== 'question') {
    throw new HivemindError('validation_failed', 'An answer replies to a question.', {
      field: 'in_reply_to',
    });
  }
}

export async function enforceLimits(
  tx: UnitOfWork,
  senderId: string,
  input: SendInput,
  nowMs: number
): Promise<void> {
  const since = formatTime(new Date(nowMs - senderWindowMs));
  const sent = await tx.countSenderMessages(senderId, since);

  if (sent >= senderLimit) {
    throw limited(await tx.oldestSenderMessage(senderId, since), senderWindowMs, nowMs);
  }

  if (input.audience === 'all' && input.kind !== 'relayed_instruction') {
    const window = formatTime(new Date(nowMs - broadcastWindowMs));
    const broadcasts = await tx.countBroadcasts(senderId, window);

    if (broadcasts >= broadcastLimit) {
      throw limited(await tx.oldestBroadcast(senderId, window), broadcastWindowMs, nowMs);
    }
  }

  if (input.kind === 'question' && (await tx.countOpenQuestions(senderId)) >= openQuestionLimit) {
    throw new HivemindError('rate_limited', 'The sender has too many open questions.', {
      limit: openQuestionLimit,
    });
  }
}

function limited(oldest: string | null, windowMs: number, nowMs: number): HivemindError {
  const remaining = oldest === null ? windowMs : Date.parse(oldest) + windowMs - nowMs;

  return new HivemindError('rate_limited', 'The sender has reached the message limit.', {
    retry_after: Math.max(1, Math.ceil(remaining / 1000)),
  });
}
