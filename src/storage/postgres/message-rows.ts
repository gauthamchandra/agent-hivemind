import {
  requireCopyId,
  requireGroupId,
  requireMessageId,
  requireSessionId,
  requireTaskId,
  requireWaitId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type {
  ClaimedDelivery,
  DroppedCopy,
  MessageRecord,
  OutboxCopy,
  WaitRecord,
} from '@/domain/message.ts';
import { isCopyState, isDropReason, isMessageKind, mailLogLimit } from '@/domain/message.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import {
  count,
  many,
  one,
  readNullableString,
  readNullableTime,
  readNumber,
  readString,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export async function oldestAt(
  sql: Sql,
  senderId: string,
  since: string,
  broadcasts: boolean
): Promise<string | null> {
  const row = await one(
    sql,
    `SELECT MIN(created_at) AS oldest FROM messages
     WHERE sender_id = $1 AND created_at > $2::timestamptz
       AND ($3::boolean = false OR audience = 'all')`,
    [senderId, since, broadcasts]
  );

  return readNullableTime(row?.oldest);
}

export async function droppedCopies(
  sql: Sql,
  text: string,
  params: unknown[]
): Promise<DroppedCopy[]> {
  const rows = await many(sql, text, params);

  return rows.map(row => ({
    messageId: requireMessageId(readString(row, 'message_id')),
    recipientId: requireSessionId(readString(row, 'recipient_id')),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    groupId: requireGroupId(readString(row, 'group_id')),
    taskId: requireTaskId(readString(row, 'task_id')),
    reason: reasonOf(readString(row, 'outcome_reason')),
  }));
}

export async function claimedDelivery(sql: Sql, copy: OutboxCopy): Promise<ClaimedDelivery | null> {
  const row = await one(
    sql,
    `SELECT recipient.platform_session_ref, message.sender_kind, message.sender_id,
            message.sender_role, message.sender_task_id, message.kind, message.body,
            message.in_reply_to
     FROM messages message
     JOIN sessions recipient ON recipient.id = $2
     WHERE message.id = $1`,
    [copy.message_id, copy.recipient_id]
  );

  if (row === null) return null;

  const ref = readNullableString(row, 'platform_session_ref');
  const kind = readString(row, 'kind');
  const reply = readNullableString(row, 'in_reply_to');
  const senderKind = readString(row, 'sender_kind');

  if (ref === null || !isMessageKind(kind)) return null;
  if (senderKind !== 'session' && senderKind !== 'person') return null;

  return {
    copy,
    recipientRef: ref,
    senderKind,
    senderId: readString(row, 'sender_id'),
    senderRole: readString(row, 'sender_role'),
    senderTaskId: requireTaskId(readString(row, 'sender_task_id')),
    kind,
    body: readString(row, 'body'),
    inReplyTo: reply === null ? null : requireMessageId(reply),
  };
}

export function parseMessage(row: Row): MessageRecord {
  const kind = readString(row, 'kind');
  const audience = readString(row, 'audience');
  const senderKind = readString(row, 'sender_kind');
  const reply = readNullableString(row, 'in_reply_to');

  if (!isMessageKind(kind) || (audience !== 'one' && audience !== 'all' && audience !== 'none')) {
    throw unreadable();
  }

  if (senderKind !== 'session' && senderKind !== 'person') throw unreadable();

  return {
    id: requireMessageId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    group_id: requireGroupId(readString(row, 'group_id')),
    sender_kind: senderKind,
    sender_id: readString(row, 'sender_id'),
    sender_role: readString(row, 'sender_role'),
    sender_task_id: requireTaskId(readString(row, 'sender_task_id')),
    kind,
    audience,
    in_reply_to: reply === null ? null : requireMessageId(reply),
    body: readString(row, 'body'),
    idempotency_key: readString(row, 'idempotency_key'),
    created_at: timeOf(row, 'created_at'),
  };
}

export function parseCopy(row: Row): OutboxCopy {
  const state = readString(row, 'state');
  const outcome = readNullableString(row, 'outcome_reason');

  if (!isCopyState(state) || (outcome !== null && !isDropReason(outcome))) throw unreadable();

  return {
    id: requireCopyId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    group_id: requireGroupId(readString(row, 'group_id')),
    connection_id: readString(row, 'connection_id'),
    message_id: requireMessageId(readString(row, 'message_id')),
    recipient_id: requireSessionId(readString(row, 'recipient_id')),
    sequence: readNumber(row, 'sequence'),
    claim_generation: readNumber(row, 'claim_generation'),
    state,
    attempts: readNumber(row, 'attempts'),
    busy_streak: readNumber(row, 'busy_streak'),
    next_attempt_at: timeOf(row, 'next_attempt_at'),
    claimed_by: readNullableString(row, 'claimed_by'),
    claimed_until: readNullableTime(row.claimed_until),
    outcome_reason: outcome,
    platform_reference: readNullableString(row, 'platform_reference'),
    created_at: timeOf(row, 'created_at'),
    delivered_at: readNullableTime(row.delivered_at),
  };
}

export function parseWait(row: Row): WaitRecord {
  const question = readNullableString(row, 'question_id');

  return {
    id: requireWaitId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    group_id: requireGroupId(readString(row, 'group_id')),
    waiting_session_id: requireSessionId(readString(row, 'waiting_session_id')),
    awaited_session_id: requireSessionId(readString(row, 'awaited_session_id')),
    question_id: question === null ? null : requireMessageId(question),
    deadline_at: timeOf(row, 'deadline_at'),
    created_at: timeOf(row, 'created_at'),
    cleared_at: readNullableTime(row.cleared_at),
  };
}

function timeOf(row: Row, key: string): string {
  const value = readNullableTime(row[key]);

  if (value === null) throw unreadable();

  return value;
}

export async function readInbox(
  sql: Sql,
  workspaceId: string,
  groupId: string,
  sessionId: string,
  kind: string | null,
  unanswered: boolean
) {
  const rows = await many(
    sql,
    `SELECT * FROM messages
     WHERE workspace_id = $1 AND group_id = $2
       AND (sender_id = $3 OR id IN (SELECT message_id FROM outbox_copies WHERE recipient_id = $3))
       AND ($4::text IS NULL OR kind = $4)
       AND (
         $5::boolean = false OR (
           kind = 'question' AND NOT EXISTS (
             SELECT 1 FROM messages answer
             WHERE answer.in_reply_to = messages.id
               AND answer.kind = 'answer'
               AND answer.sender_id = $3
           )
         )
       )
     ORDER BY created_at DESC, id DESC LIMIT ${mailLogLimit}`,
    [workspaceId, groupId, sessionId, kind, unanswered]
  );

  return rows.map(parseMessage);
}

export async function readMailPage(sql: Sql, workspaceId: string, groupId: string) {
  const total = await count(
    sql,
    'SELECT count(*) FROM messages WHERE workspace_id = $1 AND group_id = $2',
    [workspaceId, groupId]
  );
  const messages = (
    await many(
      sql,
      `SELECT * FROM messages WHERE workspace_id = $1 AND group_id = $2
       ORDER BY created_at DESC, id DESC LIMIT ${mailLogLimit}`,
      [workspaceId, groupId]
    )
  ).map(parseMessage);
  const ids = messages.map(message => message.id);
  const copies =
    ids.length === 0
      ? []
      : (
          await many(
            sql,
            'SELECT * FROM outbox_copies WHERE message_id = ANY($1::text[]) ORDER BY sequence',
            [ids]
          )
        ).map(parseCopy);

  return { messages, copies, removed: Math.max(0, total - messages.length) };
}

function reasonOf(value: string): DroppedCopy['reason'] {
  if (!isDropReason(value)) throw unreadable();

  return value;
}
