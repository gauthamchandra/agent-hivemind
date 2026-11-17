import type { UnitOfWork } from '@/ports/storage.ts';
import { queueWork } from '@/storage/postgres/message-queue.ts';
import {
  oldestAt,
  parseCopy,
  parseMessage,
  parseWait,
  readInbox,
  readMailPage,
} from '@/storage/postgres/message-rows.ts';
import { readSessions } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { count, many, one, readNumber, run } from '@/storage/postgres/store-query.ts';

export function messageWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'insertMessage'
  | 'insertCopy'
  | 'nextCopySequence'
  | 'countSenderMessages'
  | 'oldestSenderMessage'
  | 'countBroadcasts'
  | 'oldestBroadcast'
  | 'countOpenQuestions'
  | 'findMessage'
  | 'loadMessage'
  | 'copiesOf'
  | 'waitsInGroup'
  | 'insertWait'
  | 'clearQuestionWaits'
  | 'clearWait'
  | 'clearSessionWaits'
  | 'groupSessions'
  | 'releaseExpiredClaims'
  | 'lockGroupsWithOutbox'
  | 'dropExpiredCopies'
  | 'dropUnavailableCopies'
  | 'claimDelivery'
  | 'takeMessageBudget'
  | 'pauseConnection'
  | 'settleCopy'
  | 'inbox'
  | 'mailPage'
> {
  return { ...recordWork(sql), ...queueWork(sql) };
}

type StoredMessages = Pick<
  UnitOfWork,
  | 'insertMessage'
  | 'insertCopy'
  | 'nextCopySequence'
  | 'countSenderMessages'
  | 'oldestSenderMessage'
  | 'countBroadcasts'
  | 'oldestBroadcast'
  | 'countOpenQuestions'
  | 'findMessage'
  | 'loadMessage'
  | 'copiesOf'
  | 'waitsInGroup'
  | 'insertWait'
  | 'clearQuestionWaits'
  | 'clearWait'
  | 'clearSessionWaits'
  | 'groupSessions'
  | 'inbox'
  | 'mailPage'
>;

function recordWork(sql: Sql): StoredMessages {
  return {
    insertMessage: message => insertMessage(sql, message),
    insertCopy: copy => insertCopy(sql, copy),
    nextCopySequence: recipientId => nextSequence(sql, recipientId),
    countSenderMessages: (senderId, since) =>
      count(
        sql,
        'SELECT count(*) FROM messages WHERE sender_id = $1 AND created_at > $2::timestamptz',
        [senderId, since]
      ),
    oldestSenderMessage: (senderId, since) => oldestAt(sql, senderId, since, false),
    countBroadcasts: (senderId, since) =>
      count(
        sql,
        `SELECT count(*) FROM messages
         WHERE sender_id = $1 AND audience = 'all' AND created_at > $2::timestamptz`,
        [senderId, since]
      ),
    oldestBroadcast: (senderId, since) => oldestAt(sql, senderId, since, true),
    countOpenQuestions: senderId =>
      count(
        sql,
        `SELECT count(*) FROM messages question
         WHERE question.sender_id = $1 AND question.kind = 'question'
           AND NOT EXISTS (
             SELECT 1 FROM messages answer
             WHERE answer.in_reply_to = question.id AND answer.kind = 'answer'
           )`,
        [senderId]
      ),
    findMessage: async (workspaceId, groupId, id) => {
      const row = await one(
        sql,
        'SELECT * FROM messages WHERE workspace_id = $1 AND group_id = $2 AND id = $3',
        [workspaceId, groupId, id]
      );

      return row === null ? null : parseMessage(row);
    },
    loadMessage: async id => {
      const row = await one(sql, 'SELECT * FROM messages WHERE id = $1', [id]);

      return row === null ? null : parseMessage(row);
    },
    copiesOf: async messageId => {
      const rows = await many(
        sql,
        'SELECT * FROM outbox_copies WHERE message_id = $1 ORDER BY sequence, recipient_id',
        [messageId]
      );

      return rows.map(parseCopy);
    },
    waitsInGroup: async (workspaceId, groupId) => {
      const rows = await many(
        sql,
        'SELECT * FROM waits WHERE workspace_id = $1 AND group_id = $2 ORDER BY created_at, id',
        [workspaceId, groupId]
      );

      return rows.map(parseWait);
    },
    insertWait: wait => insertWait(sql, wait),
    clearQuestionWaits: (questionId, answererId, at) =>
      run(
        sql,
        `UPDATE waits SET cleared_at = $3::timestamptz
         WHERE question_id = $1 AND awaited_session_id = $2 AND cleared_at IS NULL`,
        [questionId, answererId, at]
      ),
    clearWait: (waitId, waiterId, at) => clearOneWait(sql, waitId, waiterId, at),
    clearSessionWaits: (sessionId, at) =>
      run(
        sql,
        `UPDATE waits SET cleared_at = $2::timestamptz
         WHERE cleared_at IS NULL AND (waiting_session_id = $1 OR awaited_session_id = $1)`,
        [sessionId, at]
      ),
    groupSessions: (workspaceId, groupId) => readSessions(sql, workspaceId, groupId),
    inbox: (workspaceId, groupId, sessionId, kind, unanswered) =>
      readInbox(sql, workspaceId, groupId, sessionId, kind, unanswered),
    mailPage: (workspaceId, groupId) => readMailPage(sql, workspaceId, groupId),
  };
}

function insertMessage(sql: Sql, message: Parameters<UnitOfWork['insertMessage']>[0]) {
  return run(
    sql,
    `INSERT INTO messages (
       id, workspace_id, group_id, sender_kind, sender_id, sender_role, sender_task_id,
       kind, audience, in_reply_to, body, idempotency_key, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz)`,
    [
      message.id,
      message.workspace_id,
      message.group_id,
      message.sender_kind,
      message.sender_id,
      message.sender_role,
      message.sender_task_id,
      message.kind,
      message.audience,
      message.in_reply_to,
      message.body,
      message.idempotency_key,
      message.created_at,
    ]
  );
}

function insertCopy(sql: Sql, copy: Parameters<UnitOfWork['insertCopy']>[0]) {
  return run(
    sql,
    `INSERT INTO outbox_copies (
       id, workspace_id, group_id, connection_id, message_id, recipient_id, sequence,
       claim_generation, state, attempts, busy_streak, next_attempt_at, claimed_by,
       claimed_until, outcome_reason, platform_reference, created_at, delivered_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14::timestamptz,$15,$16,
       $17::timestamptz,$18::timestamptz
     )`,
    [
      copy.id,
      copy.workspace_id,
      copy.group_id,
      copy.connection_id,
      copy.message_id,
      copy.recipient_id,
      copy.sequence,
      copy.claim_generation,
      copy.state,
      copy.attempts,
      copy.busy_streak,
      copy.next_attempt_at,
      copy.claimed_by,
      copy.claimed_until,
      copy.outcome_reason,
      copy.platform_reference,
      copy.created_at,
      copy.delivered_at,
    ]
  );
}

async function nextSequence(sql: Sql, recipientId: string): Promise<number> {
  const row = await one(
    sql,
    'SELECT (COALESCE(MAX(sequence), 0) + 1)::int AS next FROM outbox_copies WHERE recipient_id = $1',
    [recipientId]
  );

  return readNumber(row ?? {}, 'next');
}

function insertWait(sql: Sql, wait: Parameters<UnitOfWork['insertWait']>[0]) {
  return run(
    sql,
    `INSERT INTO waits (
       id, workspace_id, group_id, waiting_session_id, awaited_session_id, question_id,
       deadline_at, created_at, cleared_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz)`,
    [
      wait.id,
      wait.workspace_id,
      wait.group_id,
      wait.waiting_session_id,
      wait.awaited_session_id,
      wait.question_id,
      wait.deadline_at,
      wait.created_at,
      wait.cleared_at,
    ]
  );
}

async function clearOneWait(
  sql: Sql,
  waitId: string,
  waiterId: string,
  at: string
): Promise<Awaited<ReturnType<UnitOfWork['clearWait']>>> {
  const updated = await one(
    sql,
    `UPDATE waits SET cleared_at = $3::timestamptz
     WHERE id = $1 AND waiting_session_id = $2 AND cleared_at IS NULL
     RETURNING *`,
    [waitId, waiterId, at]
  );

  if (updated !== null) return parseWait(updated);

  const existing = await one(sql, 'SELECT * FROM waits WHERE id = $1 AND waiting_session_id = $2', [
    waitId,
    waiterId,
  ]);

  return existing === null ? null : parseWait(existing);
}
