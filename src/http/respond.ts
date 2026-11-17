import type { ServiceDeps } from '@/core/deps.ts';
import type { ErrorCode } from '@/domain/errors.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { ConnectionId, PersonId, WorkspaceId } from '@/domain/ids.ts';
import { requirePersonId, requireWorkspaceId } from '@/domain/ids.ts';
import type { EvidenceEntry, SessionRecord, TaskState, VerificationMode } from '@/domain/model.ts';
import { isTaskState, isVerificationMode } from '@/domain/model.ts';
import type { PlatformErrorClass } from '@/domain/platform.ts';
import { sha256Hex } from '@/domain/secret.ts';
import { parseTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export const maxBody = 256 * 1024;

export type HttpOptions = {
  deps: ServiceDeps;
  platforms: Platforms;
  connectionId: ConnectionId;
  port?: number;
};

export type KeyCaller = {
  kind: 'key';
  personId: PersonId;
  role: string;
  workspaceId: WorkspaceId;
};

export async function requireKey(options: HttpOptions, request: Request): Promise<KeyCaller> {
  const secret = requireBearer(request);

  if (!secret.startsWith('opk_')) {
    throw new HivemindError('unauthenticated', 'The operator key is not valid.');
  }

  const record = await options.deps.store.transact(tx => tx.operatorKeyByHash(sha256Hex(secret)));
  const now = options.deps.clock.now().getTime();

  if (
    record === null ||
    record.revoked_at !== null ||
    record.person_id === null ||
    (record.expires_at !== null && now >= parseTime(record.expires_at).getTime()) ||
    (record.role !== 'creator' && record.role !== 'administrator')
  ) {
    throw new HivemindError('unauthenticated', 'The operator key is not valid.');
  }

  return {
    kind: 'key',
    personId: requirePersonId(record.person_id),
    role: record.role,
    workspaceId: requireWorkspaceId(record.workspace_id),
  };
}

export function requireBearer(request: Request): string {
  const token = bearer(request);

  if (token === null) throw new HivemindError('unauthenticated', 'The request has no credential.');

  return token;
}

export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');

  if (header === null) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header);

  return match?.[1] ?? null;
}

export function requireIdempotency(request: Request): string {
  const key = request.headers.get('idempotency-key');

  if (key === null || key.trim().length === 0) {
    throw new HivemindError('validation_failed', 'The request needs an Idempotency-Key header.', {
      field: 'Idempotency-Key',
    });
  }

  return key;
}

export function pending(session: SessionRecord): Response {
  return json(202, {
    error: {
      code: 'start_pending',
      message: 'The platform did not say whether it started the session.',
      details: { session_id: session.id },
    },
    session_id: session.id,
    session: publicSession(session),
  });
}

export function publicSession(session: SessionRecord): Omit<SessionRecord, 'token_hash'> {
  const { token_hash: _token, ...rest } = session;

  return rest;
}

export function platformFailure(errorClass: PlatformErrorClass): HivemindError {
  if (errorClass === 'auth') {
    return new HivemindError('platform_auth_failed', 'The platform refused the credential.');
  }

  if (errorClass === 'rate_limited') {
    return new HivemindError('platform_rate_limited', 'The platform asked the service to slow.');
  }

  if (errorClass === 'quota') {
    return new HivemindError('platform_quota', 'The platform account reached a limit.');
  }

  return new HivemindError('validation_failed', 'The platform rejected the start.');
}

export function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HivemindError('validation_failed', 'The request body must be a JSON object.');
    }

    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HivemindError) throw error;

    throw new HivemindError('validation_failed', 'The request body is not JSON.');
  }
}

export function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== 'string') {
    throw new HivemindError('validation_failed', `The ${field} is missing.`, { field });
  }

  return value;
}

export function readNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HivemindError('validation_failed', `The ${field} is missing.`, { field });
  }

  return value;
}

export function readState(value: unknown): TaskState {
  if (typeof value !== 'string' || !isTaskState(value)) {
    throw new HivemindError('validation_failed', 'The target state is not valid.', { field: 'to' });
  }

  return value;
}

export function readMode(value: unknown): VerificationMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && isVerificationMode(value)) return value;

  throw new HivemindError('validation_failed', 'The verification mode is not valid.', {
    field: 'verification_mode',
  });
}

export function readEvidence(value: unknown): EvidenceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HivemindError('validation_failed', 'Evidence must be a list.', { field: 'evidence' });
  }

  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new HivemindError('validation_failed', 'An evidence entry is not valid.', {
        field: 'evidence',
      });
    }

    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const label = record.label;
    const item = record.value;

    if (
      (kind !== 'address' && kind !== 'text') ||
      typeof label !== 'string' ||
      typeof item !== 'string'
    ) {
      throw new HivemindError('validation_failed', 'An evidence entry is not valid.', {
        field: 'evidence',
      });
    }

    return { kind, label, value: item };
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function fail(error: HivemindError, requestId: string): Response {
  const response = json(statusFor(error.code), {
    error: { code: error.code, message: error.message, details: error.details },
    request_id: requestId,
  });

  response.headers.set('x-request-id', requestId);

  return response;
}

export function statusFor(code: ErrorCode): number {
  if (code === 'unauthenticated') return 401;
  if (code === 'forbidden' || code === 'policy_denied' || code === 'session_not_active') return 403;
  if (code === 'not_found') return 404;
  if (code === 'validation_failed' || code === 'evidence_required') return 422;
  if (code === 'payload_too_large') return 413;
  if (code === 'start_pending') return 202;
  if (code === 'platform_unavailable' || code === 'platform_auth_failed') return 502;
  if (code === 'platform_rate_limited' || code === 'unavailable') return 503;
  if (code === 'ambiguous_credentials') return 400;

  return 409;
}
