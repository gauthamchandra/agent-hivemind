import { clearNamedWait, listInbox, readMail, recordWait } from '@/core/message-read.ts';
import { sendMessage } from '@/core/send-message.ts';
import { HivemindError } from '@/domain/errors.ts';
import { requireGroupId, requireMessageId, requireSessionId, requireTaskId } from '@/domain/ids.ts';
import { isMessageKind } from '@/domain/message.ts';
import type { SessionRecord, SessionRole } from '@/domain/model.ts';
import { isSessionRole } from '@/domain/model.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { HttpOptions } from '@/http/respond.ts';
import { json, readNumber, readString, requireIdempotency, requireKey } from '@/http/respond.ts';

export async function sessionMessageRoute(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string,
  active: SessionRecord
): Promise<Response | null> {
  if (request.method === 'POST' && path === '/v1/messages') {
    const sent = await sendMessage(options.deps, {
      workspaceId: active.workspace_id,
      sender: { kind: 'session', sessionId: active.id },
      ...messageFields(body),
      idempotencyKey: requireIdempotency(request),
      bodyHash: sha256Hex(raw),
    });

    return json(201, sent);
  }

  if (request.method === 'GET' && path === '/v1/messages') {
    const url = new URL(request.url);
    const kind = url.searchParams.get('kind');

    return json(
      200,
      await listInbox(options.deps, {
        workspaceId: active.workspace_id,
        groupId: active.group_id,
        sessionId: active.id,
        kind,
        unanswered: url.searchParams.get('unanswered') === 'true',
      })
    );
  }

  if (request.method === 'POST' && path === '/v1/waits') {
    const question = optional(body, 'question_id');
    const wait = await recordWait(options.deps, {
      workspaceId: active.workspace_id,
      sessionId: active.id,
      awaitedId: requireSessionId(readString(body, 'awaited_session_id')),
      seconds: readNumber(body, 'seconds'),
      questionId: question === null ? null : requireMessageId(question),
    });

    return json(201, { wait });
  }

  const clear = path.match(/^\/v1\/waits\/([^/]+)$/);

  if (request.method === 'DELETE' && clear?.[1]) {
    const wait = await clearNamedWait(options.deps, {
      workspaceId: active.workspace_id,
      sessionId: active.id,
      waitId: decodeURIComponent(clear[1]),
    });

    return json(200, { wait });
  }

  return null;
}

export async function ownerMessageRoute(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string
): Promise<Response | null> {
  const match = path.match(/^\/v1\/groups\/([^/]+)\/messages$/);

  if (match?.[1] === undefined) return null;

  const key = await requireKey(options, request);
  const groupId = requireGroupId(decodeURIComponent(match[1]));

  if (request.method === 'GET') {
    return json(200, await readMail(options.deps, key.workspaceId, groupId));
  }

  if (request.method !== 'POST') return null;

  const sent = await sendMessage(options.deps, {
    workspaceId: key.workspaceId,
    sender: {
      kind: 'person',
      personId: key.personId,
      administrator: key.role === 'administrator',
    },
    groupId,
    ...messageFields(body),
    idempotencyKey: requireIdempotency(request),
    bodyHash: sha256Hex(`${groupId}\n${raw}`),
  });

  return json(201, sent);
}

function messageFields(body: Record<string, unknown>) {
  const kind = readString(body, 'kind');

  if (!isMessageKind(kind)) {
    throw new HivemindError('validation_failed', 'The message kind is not valid.', {
      field: 'kind',
    });
  }

  const role = optional(body, 'role');
  const reply = optional(body, 'in_reply_to');
  const recipient = optional(body, 'recipient_id');
  const task = optional(body, 'task_id');

  return {
    kind,
    body: readString(body, 'body'),
    audience: body.all === true ? ('all' as const) : ('one' as const),
    ...(recipient === null ? {} : { recipientId: requireSessionId(recipient) }),
    ...(role === null ? {} : { role: sessionRole(role) }),
    ...(task === null ? {} : { taskId: requireTaskId(task) }),
    ...(reply === null ? {} : { inReplyTo: requireMessageId(reply) }),
    ...(body.record_wait === undefined ? {} : { recordWait: body.record_wait === true }),
    ...(body.wait_seconds === undefined ? {} : { waitSeconds: readNumber(body, 'wait_seconds') }),
  };
}

function optional(body: Record<string, unknown>, field: string): string | null {
  if (!(field in body) || body[field] === null) return null;

  return readString(body, field);
}

function sessionRole(value: string): SessionRole {
  if (!isSessionRole(value)) {
    throw new HivemindError('validation_failed', 'The role is not valid.', { field: 'role' });
  }

  return value;
}
