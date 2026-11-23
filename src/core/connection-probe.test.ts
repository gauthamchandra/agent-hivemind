import { expect, spyOn, test } from 'bun:test';
import { runHousekeeping } from '@/core/housekeeping.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { runUsagePoll } from '@/core/usage-poll.ts';
import {
  closedGroupRetentionMs,
  housekeepingDeadlineMs,
  housekeepingIntervalMs,
} from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import { type ConnectionId, defaultWorkspaceId, requireConnectionId } from '@/domain/ids.ts';
import { selfHostedLimits } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { PlatformAdapter, Platforms } from '@/ports/platform.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { simulatedAdapterName } from '@/testing/platforms.ts';
import { team } from '@/testing/team.ts';
import { runAfterTest } from '@/testing/teardown.ts';

type Ctx = Awaited<ReturnType<typeof team>>;

test('a failed probe opens one critical alert and a later success clears it', async () => {
  const ctx = await team();

  quietErrors();
  ctx.simulated.queueError('probe', 'auth');
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const opened = await openConnectionAlerts(ctx);

  expect(opened).toHaveLength(1);
  expect(opened[0]?.severity).toBe('critical');
  expect(opened[0]?.groupId).toBeNull();
  expect(opened[0]?.targetId).toBe(ctx.connectionId);
  expect(await failingOf(ctx, ctx.connectionId)).toBe(true);

  ctx.deps.clock.advance(housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await openConnectionAlerts(ctx)).toHaveLength(0);
  expect(await failingOf(ctx, ctx.connectionId)).toBe(false);
  expect(await alertCount(ctx)).toBe(1);

  ctx.simulated.queueError('probe', 'unavailable');
  ctx.deps.clock.advance(housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await openConnectionAlerts(ctx)).toHaveLength(1);
  expect(await alertCount(ctx)).toBe(2);
});

test('a probe that succeeds records the connection as not failing', async () => {
  const ctx = await team();

  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'probe')).toHaveLength(1);
  expect(await openConnectionAlerts(ctx)).toHaveLength(0);
  expect(await failingOf(ctx, ctx.connectionId)).toBe(false);
});

test('a second failure keeps the one open alert and marks it seen again', async () => {
  const ctx = await team();

  quietErrors();
  ctx.simulated.queueError('probe', 'unavailable');
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });
  const opened = requirePresent((await openConnectionAlerts(ctx))[0], 'the open alert');

  ctx.simulated.queueError('probe', 'unavailable');
  ctx.deps.clock.advance(housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const again = await openConnectionAlerts(ctx);

  expect(again).toHaveLength(1);
  expect(again[0]?.id).toBe(opened.id);
  expect(again[0]?.lastSeenAt).not.toBe(opened.lastSeenAt);
  expect(await alertCount(ctx)).toBe(1);
});

test('the usage poll does not clear a connection_failing alert', async () => {
  const ctx = await team();

  quietErrors();
  ctx.simulated.queueError('probe', 'auth');
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await openConnectionAlerts(ctx)).toHaveLength(1);
});

test('a probe records its planned action before it calls the platform', async () => {
  const ctx = await team();

  await expect(
    runHousekeeping(ctx.deps, ctx.platforms, {
      workerId: 'worker',
      crashAt: 'after_planned_action',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);
  expect(ctx.simulated.calls().filter(call => call === 'probe')).toHaveLength(0);
  expect(await openConnectionAlerts(ctx)).toHaveLength(0);
  expect(await failingOf(ctx, ctx.connectionId)).toBeNull();

  const open = await ctx.deps.store.transact(tx => tx.openPlannedActions('housekeeping'));

  expect(open.map(action => action.action)).toEqual(['probe']);
  expect(open[0]?.targetId).toBe(ctx.connectionId);

  ctx.deps.clock.advance(housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'probe')).toHaveLength(1);
  expect(await ctx.deps.store.transact(tx => tx.openPlannedActions('housekeeping'))).toEqual([]);
  expect(await failingOf(ctx, ctx.connectionId)).toBe(false);
});

test('a probe whose lock id changed during the call saves nothing', async () => {
  const ctx = await team();

  quietErrors();
  const platforms = platformsFor(ctx, [], {
    probe: async () => {
      await ctx.db.query(`UPDATE job_locks SET lock_id = lock_id + 1 WHERE job = 'housekeeping'`);

      throw new PlatformError('unavailable', 'The platform did not answer.');
    },
  });

  await expect(runHousekeeping(ctx.deps, platforms, { workerId: 'worker' })).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await openConnectionAlerts(ctx)).toHaveLength(0);
  expect(await failingOf(ctx, ctx.connectionId)).toBeNull();

  const open = await ctx.deps.store.transact(tx => tx.openPlannedActions('housekeeping'));

  expect(open.map(action => action.targetId)).toEqual([ctx.connectionId]);
});

test('an unexpected probe error fails that connection and the next one is still checked', async () => {
  const ctx = await team();
  const other = await addConnection(ctx);
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  const first = requirePresent((await orderedConnections(ctx))[0], 'the first connection');

  runAfterTest(() => errors.mockRestore());

  const platforms = platformsFor(ctx, [other], {
    probe: async connection => {
      if (connection.id === first) throw new Error('The probe client crashed.');

      const source = connection.id === ctx.connectionId ? ctx.simulated : other.platform;

      return source.adapter.probe(connection);
    },
  });

  await runHousekeeping(ctx.deps, platforms, { workerId: 'worker' });

  expect(await failingOf(ctx, first)).toBe(true);
  const second = first === ctx.connectionId ? other.connectionId : ctx.connectionId;

  expect(await failingOf(ctx, second)).toBe(false);
  expect(await openConnectionAlerts(ctx)).toHaveLength(1);
  expect(errors.mock.calls.some(call => String(call[0]).includes(String(first)))).toBe(true);
});

test('a probe stops between connections once the deadline has passed', async () => {
  const ctx = await team();
  const other = await addConnection(ctx);
  const ordered = await orderedConnections(ctx);
  const first = requirePresent(ordered[0], 'the first connection');
  const second = requirePresent(ordered[1], 'the second connection');
  const probed: ConnectionId[] = [];
  const platforms = platformsFor(ctx, [other], {
    probe: async connection => {
      probed.push(connection.id);

      if (connection.id === first) ctx.deps.clock.advance(housekeepingDeadlineMs + 1);

      const source = connection.id === ctx.connectionId ? ctx.simulated : other.platform;

      return source.adapter.probe(connection);
    },
  });

  await runHousekeeping(ctx.deps, platforms, { workerId: 'worker' });

  expect(probed).toEqual([first]);
  expect(await failingOf(ctx, second)).toBeNull();
});

test('a connection the deadline does not reach keeps its failing alert', async () => {
  const ctx = await team();
  const other = await addConnection(ctx);
  const both = platformsFor(ctx, [other], {
    probe: async connection => {
      const source = sourceFor(ctx, [other], connection.id);

      return source.adapter.probe(connection);
    },
  });

  quietErrors();
  ctx.simulated.queueError('probe', 'unavailable');
  other.platform.queueError('probe', 'unavailable');
  await runHousekeeping(ctx.deps, both, { workerId: 'worker' });
  expect(await openConnectionAlerts(ctx)).toHaveLength(2);

  const ordered = await orderedConnections(ctx);
  const first = requirePresent(ordered[0], 'the first connection');
  const second = requirePresent(ordered[1], 'the second connection');

  ctx.deps.clock.advance(housekeepingIntervalMs);
  const stopping = platformsFor(ctx, [other], {
    probe: async connection => {
      if (connection.id === first) ctx.deps.clock.advance(housekeepingDeadlineMs + 1);

      const source = sourceFor(ctx, [other], connection.id);

      return source.adapter.probe(connection);
    },
  });

  await runHousekeeping(ctx.deps, stopping, { workerId: 'worker' });

  const open = await openConnectionAlerts(ctx);

  expect(open.map(alert => alert.targetId)).toEqual([second]);
  expect(await failingOf(ctx, second)).toBe(true);
  expect(await failingOf(ctx, first)).toBe(false);
  expect(await ctx.deps.store.transact(tx => tx.openPlannedActions('housekeeping'))).toEqual([]);
});

test('a probe that passes the deadline does not skip retention of a closed group', async () => {
  const ctx = await team();
  let probed = false;
  const platforms = platformsFor(ctx, [], {
    probe: async connection => {
      probed = true;
      // Retention has already run. A probe that ran first would pass the deadline and leave the group.
      ctx.deps.clock.advance(housekeepingDeadlineMs + 1);

      return ctx.simulated.adapter.probe(connection);
    },
  });

  await closeGroup(ctx);
  await runHousekeeping(ctx.deps, platforms, { workerId: 'worker' });

  expect(probed).toBe(true);
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
});

function quietErrors(): void {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());
}

async function orderedConnections(ctx: Ctx): Promise<ConnectionId[]> {
  const result = await ctx.db.query<{ id: string }>('SELECT id FROM connections ORDER BY id');

  return result.rows.map(row => requireConnectionId(row.id));
}

async function openConnectionAlerts(ctx: Ctx) {
  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  return snapshot.alerts.filter(alert => alert.rule === 'connection_failing');
}

async function failingOf(ctx: Ctx, connectionId: ConnectionId): Promise<boolean | null> {
  const result = await ctx.db.query<{ failing: boolean }>(
    'SELECT failing FROM connection_job_state WHERE connection_id = $1',
    [connectionId]
  );
  const row = result.rows[0];

  return row === undefined ? null : row.failing;
}

async function alertCount(ctx: Ctx): Promise<number> {
  const result = await ctx.db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM alerts WHERE rule = 'connection_failing'`,
    []
  );

  return requirePresent(result.rows[0], 'the count row').count;
}

type ExtraConnection = {
  connectionId: ConnectionId;
  platform: ReturnType<typeof createSimulatedPlatform>;
};

async function addConnection(ctx: Ctx): Promise<ExtraConnection> {
  const connectionId = ctx.deps.ids.connection();
  const workspaceId = ctx.deps.ids.workspace();
  const now = formatTime(ctx.deps.clock.now());

  await ctx.deps.store.transact(tx =>
    tx.insertWorkspace({
      id: workspaceId,
      name: 'Other',
      status: 'active',
      limits: selfHostedLimits,
      created_at: now,
    })
  );
  await ctx.deps.store.saveConnection({
    workspaceId,
    id: connectionId,
    adapter: simulatedAdapterName,
    createdAt: now,
  });

  return { connectionId, platform: createSimulatedPlatform(connectionId) };
}

function platformsFor(
  ctx: Ctx,
  others: ExtraConnection[],
  overrides: { probe: PlatformAdapter['probe'] }
): Platforms {
  return {
    require(id) {
      const source = sourceFor(ctx, others, id);

      return {
        connection: source.connection(),
        adapter: { ...source.adapter, probe: overrides.probe },
      };
    },
  };
}

function sourceFor(ctx: Ctx, others: ExtraConnection[], id: ConnectionId) {
  if (id === ctx.connectionId) return ctx.simulated;

  const other = others.find(item => item.connectionId === id);

  if (other === undefined) {
    throw new HivemindError('not_found', 'No connection with that identifier exists.');
  }

  return other.platform;
}

async function closeGroup(ctx: Ctx): Promise<void> {
  const closedAt = formatTime(new Date(ctx.deps.clock.now().getTime() - closedGroupRetentionMs));

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', final_usage_pending = false, platform_stop_pending = false,
         token_hash = NULL, platform_session_ref = NULL
     WHERE group_id = $1`,
    [ctx.opened.group.id]
  );
  await ctx.db.query(
    `UPDATE groups SET status = 'closed', closed_at = $2::timestamptz WHERE id = $1`,
    [ctx.opened.group.id, closedAt]
  );
}
