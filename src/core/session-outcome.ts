import type { ServiceDeps } from '@/core/deps.ts';
import type { StartOutcome } from '@/core/session-types.ts';
import type { SessionRecord } from '@/domain/model.ts';
import type { PlatformErrorClass } from '@/domain/platform.ts';

export async function storedOutcome(
  deps: ServiceDeps,
  session: SessionRecord
): Promise<StartOutcome> {
  if (session.life !== 'start_failed') return outcomeFrom(session);

  const events = await deps.store.events(session.workspace_id, session.group_id);
  const failed = events.findLast(
    event => event.kind === 'session_start_failed' && event.data.session_id === session.id
  );
  const recorded = failed?.data.error_class;

  return {
    outcome: 'refused',
    session,
    errorClass: isPlatformErrorClass(recorded) ? recorded : 'invalid',
  };
}

export function isPlatformErrorClass(value: unknown): value is PlatformErrorClass {
  return (
    value === 'auth' ||
    value === 'rate_limited' ||
    value === 'quota' ||
    value === 'invalid' ||
    value === 'not_found' ||
    value === 'unavailable'
  );
}

/** A replay still has a platform stop or a usage read to finish. Other terminal rows do not. */
export function owesCleanup(session: SessionRecord): boolean {
  const pending = session.final_usage_pending || session.platform_stop_pending;

  if (session.life === 'start_failed') return pending;

  return session.life === 'ended' && (pending || session.platform_session_ref === null);
}

export function outcomeFrom(session: SessionRecord): StartOutcome {
  if (session.life === 'starting') return { outcome: 'start_pending', session };
  if (session.life === 'start_failed') {
    return { outcome: 'refused', session, errorClass: 'invalid' };
  }
  if (session.life === 'ended') return { outcome: 'ended', session };
  if (session.life === 'released') return { outcome: 'released', session };

  return { outcome: 'live', session };
}
