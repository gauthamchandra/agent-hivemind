import { endSession } from '@/core/session-end.ts';
import { releaseSession, resumeSession } from '@/core/session-release.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { HttpOptions } from '@/http/respond.ts';
import { json, publicSession, readString, requireIdempotency } from '@/http/respond.ts';

export async function selfRoute(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string,
  active: SessionRecord
): Promise<Response | null> {
  const { deps } = options;
  if (request.method === 'GET' && path === '/v1/session') {
    const group = await deps.store.group(active.workspace_id, active.group_id);

    return json(200, {
      id: active.id,
      role: active.role,
      task_id: active.task_id,
      group_id: active.group_id,
      group_name: group?.name ?? '',
      life: active.life,
      parent_session_id: active.parent_session_id,
      attempt: active.attempt,
      title: active.title,
    });
  }

  if (request.method === 'POST' && path === '/v1/session/release') {
    return json(200, {
      session: publicSession(
        await releaseSession(deps, {
          workspaceId: active.workspace_id,
          sessionId: active.id,
          idempotency: { key: requireIdempotency(request), bodyHash: sha256Hex(raw) },
        })
      ),
    });
  }

  if (request.method === 'POST' && path === '/v1/session/resume') {
    return json(200, {
      session: publicSession(
        await resumeSession(deps, {
          workspaceId: active.workspace_id,
          sessionId: active.id,
          idempotency: { key: requireIdempotency(request), bodyHash: sha256Hex(raw) },
        })
      ),
    });
  }

  if (request.method === 'POST' && path === '/v1/session/end') {
    const ended = await endSession(deps, options.platforms, {
      workspaceId: active.workspace_id,
      sessionId: active.id,
      actor: { kind: 'session', sessionId: active.id },
      reason: readString(body, 'reason'),
    });

    return json(200, { session: publicSession(ended) });
  }

  if (request.method === 'GET' && path === '/v1/group') {
    const group = await deps.store.group(active.workspace_id, active.group_id);

    if (group === null)
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');

    return json(200, { group });
  }
  return null;
}
