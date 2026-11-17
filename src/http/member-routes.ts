import { endSession } from '@/core/session-end.ts';
import { startSession } from '@/core/session-start.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId } from '@/domain/ids.ts';
import { requireSessionId, requireTaskId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { isSessionRole } from '@/domain/model.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { HttpOptions } from '@/http/respond.ts';
import {
  json,
  pending,
  platformFailure,
  publicSession,
  readString,
  requireIdempotency,
} from '@/http/respond.ts';

export async function memberRoutes(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string,
  active: SessionRecord
): Promise<Response | null> {
  const { deps } = options;
  if (request.method === 'GET' && path === '/v1/sessions') {
    const sessions = await deps.store.sessions(active.workspace_id, active.group_id);

    return json(200, { sessions: sessions.map(publicSession) });
  }

  if (request.method === 'POST' && path === '/v1/sessions') {
    return memberStart(options, active, body, raw, request, null);
  }

  const replace = path.match(/^\/v1\/sessions\/([^/]+)\/replace$/);
  const end = path.match(/^\/v1\/sessions\/([^/]+)\/end$/);

  if (replace?.[1] && request.method === 'POST') {
    const target = await deps.store.session(
      active.workspace_id,
      requireSessionId(decodeURIComponent(replace[1]))
    );

    if (target === null || target.group_id !== active.group_id) {
      throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
    }

    return memberStart(
      options,
      active,
      { ...body, role: target.role, task_id: target.task_id },
      raw,
      request,
      target.id
    );
  }

  if (end?.[1] && request.method === 'POST') {
    const targetId = requireSessionId(decodeURIComponent(end[1]));

    const ended = await endSession(deps, options.platforms, {
      workspaceId: active.workspace_id,
      sessionId: targetId,
      actor: { kind: 'session', sessionId: active.id },
      reason: readString(body, 'reason'),
    });

    return json(200, { session: publicSession(ended) });
  }
  return null;
}

export async function memberStart(
  options: HttpOptions,
  active: SessionRecord,
  body: Record<string, unknown>,
  raw: string,
  request: Request,
  replacementOf: SessionId | null
): Promise<Response> {
  const role = readString(body, 'role');

  if (!isSessionRole(role)) {
    throw new HivemindError('validation_failed', 'The role is not valid.', { field: 'role' });
  }

  const started = await startSession(options.deps, options.platforms, {
    workspaceId: active.workspace_id,
    groupId: active.group_id,
    taskId: requireTaskId(readString(body, 'task_id')),
    role,
    instructions: readString(body, 'instructions'),
    actor: { kind: 'session', sessionId: active.id },
    idempotencyKey: requireIdempotency(request),
    bodyHash: sha256Hex(raw),
    replacementOf,
  });

  if (started.outcome === 'start_pending') return pending(started.session);
  if (started.outcome === 'refused') throw platformFailure(started.errorClass ?? 'invalid');
  if (started.outcome === 'ended' || started.outcome === 'released') {
    return json(200, { session: publicSession(started.session) });
  }

  return json(201, { session: publicSession(started.session) });
}
