import type { ServiceDeps } from '@/core/deps.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { FindResult, Platforms } from '@/ports/platform.ts';

/** Stop a platform session. A platform failure is unavailable, not a lost row. */
export async function endOnPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord,
  platformSessionRef: string
): Promise<void> {
  const handle = await platformHandle(deps, platforms, session);

  try {
    await handle.adapter.end(handle.connection, platformSessionRef);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError('unavailable', 'The platform did not stop the session.');
    }

    throw error;
  }

  await deps.store.transact(async tx => {
    const locked = await tx.lockSession(session.workspace_id, session.id);

    if (locked === null || !locked.platform_stop_pending) return;

    locked.platform_stop_pending = false;
    await tx.updateSession(locked);
  });
  session.platform_stop_pending = false;
}

/**
 * Ask whether the platform has this session.
 * A platform error is inconclusive: the caller decides whether to wait or refuse.
 */
export async function findOnPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<FindResult> {
  const handle = await platformHandle(deps, platforms, session);

  try {
    return await handle.adapter.findByKey(handle.connection, session.id, session.created_at);
  } catch (error) {
    if (error instanceof PlatformError) return { outcome: 'inconclusive' };

    throw error;
  }
}

async function platformHandle(deps: ServiceDeps, platforms: Platforms, session: SessionRecord) {
  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  return platforms.require(group.connection_id);
}
