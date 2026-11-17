import { createFirstAdministrator, createOperatorKey } from '@/core/installation.ts';
import { enroll } from '@/core/session-enroll.ts';
import { openGroup } from '@/core/session-open.ts';
import { HivemindError } from '@/domain/errors.ts';
import { requireSessionId } from '@/domain/ids.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { HttpOptions } from '@/http/respond.ts';
import {
  bearer,
  json,
  pending,
  platformFailure,
  publicSession,
  readMode,
  readString,
  requireBearer,
  requireIdempotency,
  requireKey,
} from '@/http/respond.ts';

export async function openRoute(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string
): Promise<Response | null> {
  const { deps } = options;
  if (request.method === 'GET' && path === '/healthz') return json(200, { status: 'ok' });
  if (request.method === 'GET' && path === '/readyz') {
    await deps.store.transact(tx => tx.countWorkspaces());

    return json(200, { status: 'ok' });
  }

  if (request.method === 'POST' && path === '/v1/session/enroll') {
    if (bearer(request) !== null) {
      throw new HivemindError(
        'ambiguous_credentials',
        'The request carries two kinds of credential.'
      );
    }

    const sessionId = requireSessionId(readString(body, 'session_id'));
    const code = readString(body, 'code');
    const enrolled = await enroll(deps, {
      sessionId,
      code,
      idempotencyKey: requireIdempotency(request),
      bodyHash: sha256Hex(raw),
    });

    return json(200, { token: enrolled.token });
  }

  if (request.method === 'POST' && path === '/v1/bootstrap/administrator') {
    const secret = requireBearer(request);
    const person = await createFirstAdministrator(deps, {
      bootstrapSecret: secret,
      displayName: readString(body, 'display_name'),
    });

    return json(201, { person });
  }

  if (request.method === 'POST' && path === '/v1/bootstrap/keys') {
    const secret = requireBearer(request);
    const role = readString(body, 'role');

    if (role !== 'reader' && role !== 'creator' && role !== 'administrator') {
      throw new HivemindError('validation_failed', 'The key role is not valid.', { field: 'role' });
    }

    const created = await createOperatorKey(deps, {
      bootstrapSecret: secret,
      name: readString(body, 'name'),
      role,
      expiresAt: readOptionalExpiry(body),
    });

    return json(201, {
      secret: created.secret,
      key: { id: created.record.id, name: created.record.name, role: created.record.role },
    });
  }

  if (request.method === 'POST' && path === '/v1/groups') {
    const key = await requireKey(options, request);
    const created = await openGroup(deps, options.platforms, {
      workspaceId: key.workspaceId,
      personId: key.personId,
      name: readString(body, 'name'),
      goal: readString(body, 'goal'),
      budget: readString(body, 'budget'),
      connectionId: options.connectionId,
      verificationMode: readMode(body.verification_mode),
      notes: [],
      instructions: readString(body, 'instructions'),
      idempotencyKey: requireIdempotency(request),
      bodyHash: sha256Hex(raw),
    });

    if (created.outcome === 'start_pending') return pending(created.session);
    if (created.outcome === 'refused') throw platformFailure(created.errorClass ?? 'invalid');

    return json(201, {
      group: created.group,
      root: created.root,
      session: publicSession(created.session),
    });
  }
  return null;
}

function readOptionalExpiry(body: Record<string, unknown>): string | null {
  if (!('expires_at' in body) || body.expires_at === null) return null;

  if (typeof body.expires_at !== 'string') {
    throw new HivemindError('validation_failed', 'The expires_at is not valid.', {
      field: 'expires_at',
    });
  }

  return body.expires_at;
}
