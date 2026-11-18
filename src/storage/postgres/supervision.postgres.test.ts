import { expect, test } from 'bun:test';
import type { ServiceDeps } from '@/core/deps.ts';
import { commitObservation, runFleetCheck } from '@/core/fleet-check.ts';
import { createFirstAdministrator, openInstallation } from '@/core/installation.ts';
import { openGroup } from '@/core/session-open.ts';
import { SupervisionHalted } from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import { createIds, defaultWorkspaceId } from '@/domain/ids.ts';
import { fleetIntervalMs } from '@/domain/supervision.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPostgresStore } from '@/storage/postgres/postgres.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { manualClock } from '@/testing/clock.ts';
import { testResponseKey } from '@/testing/deps.ts';
import { checkoutGroup } from '@/testing/fixtures.ts';
import { waitUntil } from '@/testing/wait.ts';

const databaseUrl = process.env.HIVEMIND_POSTGRES_URL;

test.skipIf(databaseUrl === undefined)(
  'two workers race for the fleet-check lease and one runs the tick',
  async () => {
    const url = databaseUrl ?? '';
    const ctx = await boot(url);
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = false;
    const platforms = delaying(ctx.platforms, ctx.connectionId, async () => {
      entered = true;
      await gate;
    });
    const first = runFleetCheck(ctx.depsA, platforms, null, { workerId: 'a' });

    await waitUntil(() => (entered ? true : null), 'the first worker to read usage');

    const second = await runFleetCheck(ctx.depsB, platforms, null, { workerId: 'b' });

    release();

    const winner = await first;

    expect(winner.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(ctx.simulated.calls().filter(call => call === 'readUsage')).toHaveLength(1);

    await ctx.close();
  }
);

test.skipIf(databaseUrl === undefined)(
  'the other worker writes status and usage after the holder stops',
  async () => {
    const url = databaseUrl ?? '';
    const ctx = await boot(url);
    const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

    ctx.simulated.setSessionUsage(ref, 2);
    const held = await runFleetCheck(ctx.depsA, ctx.platforms, null, { workerId: 'a' });

    expect(held.ran).toBe(true);

    ctx.clock.advance(fleetIntervalMs);
    ctx.simulated.setSessionStatus(ref, 'idle');
    ctx.simulated.setSessionUsage(ref, 7);

    const next = await runFleetCheck(ctx.depsB, ctx.platforms, null, { workerId: 'b' });
    const stored = await ctx.depsA.store.session(defaultWorkspaceId, ctx.planner.id);

    expect(next.ran).toBe(true);
    expect(stored?.last_status).toBe('idle');
    expect(stored?.usage).toBe('7');

    await ctx.close();
  }
);

test.skipIf(databaseUrl === undefined)(
  'a stale epoch is rejected and the next worker finishes the open intent',
  async () => {
    const url = databaseUrl ?? '';
    const ctx = await boot(url);
    const error = await runFleetCheck(ctx.depsA, ctx.platforms, null, {
      workerId: 'a',
      halt: 'after_intent',
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(SupervisionHalted);
    if (!(error instanceof SupervisionHalted)) throw new Error('the holder should stop');

    const intents = await ctx.depsA.store.transact(tx => tx.intents('fleet_check'));

    expect(intents.filter(intent => intent.state === 'open')).toHaveLength(1);

    ctx.clock.advance(fleetIntervalMs);
    ctx.simulated.controls.setReportedUsage(5);

    const next = await runFleetCheck(ctx.depsB, ctx.platforms, null, { workerId: 'b' });
    const session = requirePresent(
      await ctx.depsB.store.session(defaultWorkspaceId, ctx.planner.id),
      'planner'
    );

    expect(next.ran).toBe(true);
    expect(session.usage).toBe('5');
    expect(
      (await ctx.depsB.store.transact(tx => tx.intents('fleet_check'))).filter(
        intent => intent.state === 'open'
      )
    ).toHaveLength(0);

    await expect(
      commitObservation(ctx.depsA, {
        epoch: error.epoch,
        session,
        status: 'failed',
        reading: 1,
        finalReading: false,
        watch: {
          sessionId: session.id,
          workspaceId: session.workspace_id,
          badStatusStreak: 0,
          unknownStreak: 0,
          endUnconfirmedRuns: 0,
          endAttemptRuns: 0,
          inconclusiveRuns: 0,
          lastFind: null,
          statusSince: null,
          lastReadingAt: null,
          suspendedAt: null,
          suspendedProgressAt: null,
          lastObservedAt: null,
          orphanEnded: false,
        },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await ctx.depsB.store.session(defaultWorkspaceId, session.id))?.usage).toBe('5');

    await ctx.close();
  }
);

async function boot(url: string) {
  const setup = openPostgresStore(url);

  await setup.exec('DROP SCHEMA public CASCADE');
  await setup.exec('CREATE SCHEMA public');
  await setup.migrate();

  const clock = manualClock(new Date('2026-11-17T00:00:00.000Z'));
  const deps: ServiceDeps = {
    store: setup,
    clock,
    random: systemRandom,
    ids: createIds(clock, systemRandom),
    responseKey: testResponseKey,
  };
  const installation = await openInstallation(deps);
  const secret = installation.bootstrapSecret;

  if (secret === null) throw new Error('the empty store should print a bootstrap key');

  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });
  const connectionId = deps.ids.connection();
  const simulated = createSimulatedPlatform(connectionId);
  const platforms: Platforms = {
    require(id) {
      if (id !== connectionId) {
        throw new HivemindError('not_found', 'No connection with that identifier exists.');
      }

      return { adapter: simulated.adapter, connection: simulated.connection() };
    },
  };

  await deps.store.saveConnection({
    workspaceId: defaultWorkspaceId,
    id: connectionId,
    adapter: 'simulated',
    createdAt: '2026-11-17T00:00:00.000Z',
  });

  const opened = await openGroup(deps, platforms, {
    workspaceId: defaultWorkspaceId,
    personId: admin.id,
    ...checkoutGroup,
    connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'pg-supervision',
    bodyHash: 'pg-supervision',
  });

  expect(opened.outcome).toBe('live');
  if (opened.outcome !== 'live') throw new Error('planner did not start');

  const storeA = openPostgresStore(url);
  const storeB = openPostgresStore(url);

  return {
    clock,
    simulated,
    platforms,
    connectionId,
    planner: opened.session,
    depsA: { ...deps, store: storeA },
    depsB: { ...deps, store: storeB },
    async close() {
      await storeA.close();
      await storeB.close();
      await setup.close();
    },
  };
}

function delaying(
  platforms: Platforms,
  connectionId: string,
  wait: () => Promise<void>
): Platforms {
  return {
    require(id) {
      const handle = platforms.require(id);

      if (id !== connectionId) return handle;

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readUsage: async (connection, ref) => {
            await wait();

            return handle.adapter.readUsage(connection, ref);
          },
        },
      };
    },
  };
}
