import type { ServiceDeps } from '@/core/deps.ts';
import { applyReading } from '@/core/session-compensate.ts';
import {
  finishRecordedIntent,
  type RunOptions,
  recordIntent,
  SupervisionHalted,
} from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { NeutralStatus, SessionRecord } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { FleetSnapshot, SessionWatch } from '@/domain/supervision.ts';
import { emptyWatch, fleetDeadlineMs, isDeadStatus } from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function commitObservation(
  deps: ServiceDeps,
  input: {
    epoch: number;
    session: SessionRecord;
    status: NeutralStatus | null;
    reading: number | null;
    finalReading: boolean;
    watch: SessionWatch;
  }
): Promise<{ usageGrew: boolean; spend: string }> {
  const now = formatTime(deps.clock.now());
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('fleet_check', input.epoch, now))) return null;

    await tx.lockWorkspace(input.session.workspace_id);

    const group = await tx.lockGroup(input.session.workspace_id, input.session.group_id);
    const locked = await tx.lockSession(input.session.workspace_id, input.session.id);

    if (group === null || locked === null) return { usageGrew: false, spend: '0' };

    let usageGrew = false;

    if (input.reading !== null) {
      usageGrew = applyReading(group, locked, input.reading);
      if (usageGrew) {
        await tx.updateGroup(group);
        input.watch.usageGrewAt = now;
      }
      input.session.usage = locked.usage;
    }

    if (input.status !== null) {
      locked.last_status = input.status;
      input.session.last_status = input.status;
    }

    if (
      input.reading !== null &&
      input.finalReading &&
      locked.life === 'ended' &&
      locked.final_usage_pending
    ) {
      locked.final_usage_pending = false;
    }

    await tx.updateSession(locked);
    await tx.saveWatch(input.watch, 'fleet');

    return { usageGrew, spend: group.spend };
  });

  if (wrote === null) {
    throw new HivemindError('conflict', 'The lease epoch is no longer current.');
  }

  return wrote;
}

export async function finishOpenObservations(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  epoch: number,
  started: number,
  allowed: Set<string>,
  unreliable: Set<string>,
  grew: Set<string>
): Promise<Set<string>> {
  const handled = new Set<string>();
  const intents = await deps.store.transact(tx => tx.intents('fleet_check'));

  for (const intent of intents) {
    if (deps.clock.now().getTime() - started > fleetDeadlineMs) break;
    if (intent.state !== 'open' || intent.action !== 'observe') continue;

    const session = snapshot.sessions.find(item => item.id === intent.targetId);

    if (session === undefined) {
      await finishRecordedIntent(deps, 'fleet_check', epoch, intent.id);
      continue;
    }

    if (!allowed.has(session.id)) continue;

    try {
      if (await readSession(deps, platforms, snapshot, session, epoch, unreliable)) {
        grew.add(session.task_id);
      }

      await finishRecordedIntent(deps, 'fleet_check', epoch, intent.id);
    } catch (error) {
      if (error instanceof SupervisionHalted) throw error;
      if (error instanceof HivemindError && error.code === 'conflict') throw error;

      console.error(`Fleet check could not finish the open intent for ${session.id}.`, error);
      continue;
    }

    handled.add(session.id);
  }

  return handled;
}

export async function observeSession(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  options: RunOptions,
  unreliable: Set<string>
): Promise<boolean> {
  const intentId = await recordIntent(
    deps,
    options,
    'fleet_check',
    epoch,
    'observe',
    session.id,
    session.workspace_id
  );
  const grew = await readSession(deps, platforms, snapshot, session, epoch, unreliable);

  await finishRecordedIntent(deps, 'fleet_check', epoch, intentId);

  return grew;
}

async function readSession(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: FleetSnapshot,
  session: SessionRecord,
  epoch: number,
  unreliable: Set<string>
): Promise<boolean> {
  const group = snapshot.groups.find(item => item.id === session.group_id);

  if (group === undefined) return false;

  const watch = watchFor(snapshot, session);
  const now = formatTime(deps.clock.now());

  watch.lastAttemptAt = now;
  await rememberAttempt(deps, epoch, watch);
  if (unreliable.has(group.connection_id)) return false;

  const handle = platforms.require(group.connection_id);
  let status: NeutralStatus | null = null;
  let missing = false;
  let reading: number | null = null;

  if (session.platform_session_ref !== null) {
    try {
      status = (await handle.adapter.readStatus(handle.connection, session.platform_session_ref))
        .status;
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      if (error.errorClass === 'not_found') missing = true;
      else unreliable.add(group.connection_id);
    }

    if (
      handle.connection.capabilities.includes('usage_reading') &&
      !unreliable.has(group.connection_id)
    ) {
      try {
        reading = await handle.adapter.readUsage(handle.connection, session.platform_session_ref);
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        if (error.errorClass !== 'not_found') unreliable.add(group.connection_id);
      }
    }
  }

  if (unreliable.has(group.connection_id)) return false;

  if (missing) {
    watch.unknownStreak += 1;
  } else if (status !== null) {
    watch.badStatusStreak = isDeadStatus(status) ? watch.badStatusStreak + 1 : 0;
    watch.unknownStreak = 0;

    if (watch.statusSince === null || session.last_status !== status) watch.statusSince = now;
  }

  if (reading !== null) watch.lastReadingAt = now;
  watch.lastObservedAt = now;

  const previous = session.usage;
  const result = await commitObservation(deps, {
    epoch,
    session,
    status,
    reading,
    finalReading: session.life === 'ended' && session.final_usage_pending,
    watch,
  });

  group.spend = result.spend;

  return result.usageGrew || (previous !== null && session.usage !== previous);
}

async function rememberAttempt(
  deps: ServiceDeps,
  epoch: number,
  watch: SessionWatch
): Promise<void> {
  const wrote = await deps.store.transact(async tx => {
    if (!(await tx.holdLease('fleet_check', epoch, formatTime(deps.clock.now())))) return false;

    await tx.saveWatch(watch, 'fleet');

    return true;
  });

  if (!wrote) throw new HivemindError('conflict', 'The lease epoch is no longer current.');
}

function watchFor(snapshot: FleetSnapshot, session: SessionRecord): SessionWatch {
  const found = snapshot.watches.find(watch => watch.sessionId === session.id);

  if (found !== undefined) return found;

  const created = emptyWatch(session.id, session.workspace_id);

  snapshot.watches.push(created);

  return created;
}
