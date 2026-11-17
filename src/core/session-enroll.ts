import type { ServiceDeps } from '@/core/deps.ts';
import { rememberIdempotency, replayedRecord } from '@/core/record-checks.ts';
import { routeEnroll } from '@/core/session-types.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { openText, sealText, sessionTokenSecret, sha256Hex } from '@/domain/secret.ts';
import { formatTime, parseTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function enroll(
  deps: ServiceDeps,
  input: { sessionId: SessionId; code: string; idempotencyKey: string; bodyHash: string }
): Promise<{ token: string; session: SessionRecord }> {
  const enrolled = await deps.store.transact(async tx => {
    const located = await tx.sessionById(input.sessionId);

    if (located === null) {
      throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
    }

    const locked = await tx.lockSession(located.workspace_id, input.sessionId);

    if (locked === null) {
      throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
    }

    const existing = await replayedRecord(tx, located.workspace_id, {
      callerKind: 'session',
      callerId: input.sessionId,
      route: routeEnroll,
      key: input.idempotencyKey,
      bodyHash: input.bodyHash,
    });

    if (existing) {
      const token = await storedToken(deps.responseKey, existing.response);

      if (token === null) {
        throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
      }

      return { token, session: locked };
    }

    const now = formatTime(deps.clock.now());
    const record = await tx.enrollmentByHash(sha256Hex(input.code));

    if (record === null || record.session_id !== input.sessionId) {
      await noteBadCode(tx, input.sessionId, now);

      return null;
    }

    if (
      record.used_at !== null ||
      record.voided_at !== null ||
      codeExpired(deps, record.expires_at)
    ) {
      throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
    }

    if (locked.enrolled_by === 'secret') {
      throw new HivemindError('conflict', 'The session already enrolled with its injected secret.');
    }

    if (deps.responseKey.length === 0) {
      throw new HivemindError('unavailable', 'HIVEMIND_RESPONSE_KEY is not set.');
    }

    const token = sessionTokenSecret(deps.random);

    locked.token_hash = sha256Hex(token);
    locked.enrolled_at = now;
    locked.enrolled_by = 'code';

    if (locked.life === 'starting' && locked.existence_evidence_at === null) {
      locked.existence_evidence_at = now;
    }

    record.used_at = now;
    await tx.saveEnrollmentCode(record);
    await tx.updateSession(locked);
    await rememberIdempotency(
      tx,
      located.workspace_id,
      {
        callerKind: 'session',
        callerId: input.sessionId,
        route: routeEnroll,
        key: input.idempotencyKey,
        bodyHash: input.bodyHash,
      },
      locked.id,
      now,
      { sealed: await sealText(deps.responseKey, token, deps.random) }
    );

    return { token, session: locked };
  });

  if (enrolled === null) {
    throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
  }

  return enrolled;
}

async function noteBadCode(tx: UnitOfWork, sessionId: SessionId, now: string): Promise<void> {
  const open = await tx.openEnrollmentCode(sessionId);

  if (open === null) return;

  open.attempts += 1;

  if (open.attempts >= 5) open.voided_at = now;

  await tx.saveEnrollmentCode(open);
}

async function storedToken(secret: string, response: unknown): Promise<string | null> {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return null;

  const sealed = Reflect.get(response, 'sealed');

  if (typeof sealed !== 'string' || sealed.length === 0) return null;

  return openText(secret, sealed);
}

function codeExpired(deps: ServiceDeps, expiresAt: string | null): boolean {
  if (expiresAt === null) return false;

  return deps.clock.now().getTime() >= parseTime(expiresAt).getTime();
}
