import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { HttpOptions } from '@/http/respond.ts';
import { requireBearer } from '@/http/respond.ts';

export async function requireSession(
  options: HttpOptions,
  request: Request
): Promise<SessionRecord> {
  const token = requireBearer(request);

  if (!token.startsWith('ses_')) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  const hash = sha256Hex(token);
  const session = await options.deps.store.transact(tx => tx.sessionByTokenHash(hash));

  if (
    session !== null &&
    session.token_hash !== null &&
    session.life !== 'ended' &&
    session.life !== 'start_failed'
  ) {
    if (session.end_requested_at !== null && !allowedWhileEnding(request)) {
      throw new HivemindError(
        'session_not_active',
        'The session is ending and cannot start new work.',
        { life: session.life }
      );
    }

    return session;
  }

  const ended = await options.deps.store.transact(tx => tx.sessionByEndReceipt(hash));

  if (ended !== null && confirmsEndedSession(request, ended.id)) return ended;

  throw new HivemindError('unauthenticated', 'The session token is not valid.');
}

function confirmsEndedSession(request: Request, sessionId: string): boolean {
  if (request.method !== 'POST') return false;

  const path = new URL(request.url).pathname;

  if (path === '/v1/session/end') return true;

  const match = /^\/v1\/sessions\/([^/]+)\/end$/.exec(path);
  const target = match?.[1];

  return target !== undefined && decodeURIComponent(target) === sessionId;
}

function allowedWhileEnding(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;

  if (request.method !== 'POST') return false;

  const path = new URL(request.url).pathname;

  return path === '/v1/session/end' || /^\/v1\/sessions\/[^/]+\/end$/.test(path);
}
