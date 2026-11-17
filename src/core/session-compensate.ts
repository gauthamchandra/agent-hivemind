import type { ServiceDeps } from '@/core/deps.ts';
import {
  addDecimal,
  canonicalizeDecimal,
  compareDecimal,
  decimalFromNumber,
  subtractDecimal,
} from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { Platforms } from '@/ports/platform.ts';

/**
 * A compensated start can gain a platform session after the first lookup said it was absent.
 * Look again, then stop it. A stop that fails stays pending so the next attempt can finish it.
 */
export async function reclaimCompensatedStart(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (session.life !== 'start_failed') return session;

  if (session.platform_session_ref !== null && session.final_usage_pending) {
    return stopCompensatedPlatform(deps, platforms, session);
  }

  if (session.platform_session_ref !== null) return session;

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);
  let found: Awaited<ReturnType<typeof handle.adapter.findByKey>>;

  try {
    found = await handle.adapter.findByKey(handle.connection, session.id, session.created_at);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError(
        'unavailable',
        'The platform did not say whether the session exists.'
      );
    }

    throw error;
  }

  if (found.outcome === 'inconclusive') {
    throw new HivemindError('unavailable', 'The platform did not say whether the session exists.');
  }

  if (found.outcome === 'absent') return session;

  const attached = await deps.store.transact(async tx => {
    const locked = await tx.lockSession(session.workspace_id, session.id);

    if (locked === null) {
      throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
    }

    if (locked.life !== 'start_failed' || locked.platform_session_ref !== null) return locked;

    locked.platform_session_ref = found.platformSessionRef;
    locked.platform_address = found.address;
    locked.final_usage_pending = true;
    await tx.updateSession(locked);

    return locked;
  });

  if (attached.platform_session_ref === null || !attached.final_usage_pending) return attached;

  return stopCompensatedPlatform(deps, platforms, attached);
}

/** Stop a platform session that appeared after recovery had already given its place back. */
export async function stopCompensatedPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (
    session.life !== 'start_failed' ||
    session.platform_session_ref === null ||
    !session.final_usage_pending
  ) {
    return session;
  }

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);

  try {
    await handle.adapter.end(handle.connection, session.platform_session_ref);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError('unavailable', 'The platform did not stop the session.');
    }

    throw error;
  }

  await readFinalUsage(deps, platforms, session);

  return (await deps.store.session(session.workspace_id, session.id)) ?? session;
}

export async function readFinalUsage(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<void> {
  if (session.platform_session_ref === null) return;

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) return;

  try {
    const reading = await platforms
      .require(group.connection_id)
      .adapter.readUsage(
        platforms.require(group.connection_id).connection,
        session.platform_session_ref
      );

    await deps.store.transact(async tx => {
      await tx.lockWorkspace(session.workspace_id);
      const groupRow = await tx.lockGroup(session.workspace_id, session.group_id);
      const locked = await tx.lockSession(session.workspace_id, session.id);

      if (locked === null || groupRow === null) return;

      const next = decimalFromNumber(reading);
      const previous = locked.usage === null ? '0' : canonicalizeDecimal(locked.usage);
      const increase = subtractDecimal(next, previous);

      if (compareDecimal(increase, '0') > 0) {
        groupRow.spend = addDecimal(groupRow.spend, increase);
        await tx.updateGroup(groupRow);
      }

      locked.usage = compareDecimal(next, previous) > 0 ? next : previous;
      locked.final_usage_pending = false;
      await tx.updateSession(locked);
    });
  } catch (error) {
    if (error instanceof PlatformError) return;

    throw error;
  }
}
