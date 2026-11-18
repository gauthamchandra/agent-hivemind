import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { ServiceDeps } from '@/core/deps.ts';
import { createFirstAdministrator, openInstallation } from '@/core/installation.ts';
import { runReaper } from '@/core/reaper.ts';
import { writeReaperWatch } from '@/core/reaper-actions.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { createWorkerId, SupervisionHalted } from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import { createIds, defaultWorkspaceId } from '@/domain/ids.ts';
import { emptyWatch, reaperIntervalMs } from '@/domain/supervision.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPostgresStore } from '@/storage/postgres/postgres.ts';
import { manualClock } from '@/testing/clock.ts';
import { testResponseKey } from '@/testing/deps.ts';
import { checkoutGroup } from '@/testing/fixtures.ts';
import { runAfterTest } from '@/testing/teardown.ts';
import { waitUntil } from '@/testing/wait.ts';

const databaseUrl = process.env.HIVEMIND_POSTGRES_URL;

test.skipIf(databaseUrl === undefined)(
  'two workers race for the reaper lease and one runs the tick',
  async () => {
    const ctx = await boot(databaseUrl ?? '');
    const [first, second] = await Promise.all([
      runReaper(ctx.depsA, ctx.platforms, { workerId: ctx.workerA }),
      runReaper(ctx.depsB, ctx.platforms, { workerId: ctx.workerB }),
    ]);

    expect([first.ran, second.ran].filter(ran => ran)).toHaveLength(1);
    expect([first.epoch, second.epoch].filter(epoch => epoch !== null)).toEqual([1]);
    expect([ctx.workerA, ctx.workerB]).toContain(await ctx.holder('reaper'));
  }
);

test.skipIf(databaseUrl === undefined)(
  'a stale epoch is rejected and the next worker finishes the open intent',
  async () => {
    const ctx = await boot(databaseUrl ?? '');

    await expect(
      endSession(ctx.depsA, ctx.platforms, {
        workspaceId: defaultWorkspaceId,
        sessionId: ctx.plannerId,
        actor: { kind: 'service' },
        reason: 'Stop halfway.',
        crashAt: 'after_end_intent',
      })
    ).rejects.toBeInstanceOf(StoppedProcess);

    const halted = await runReaper(ctx.depsA, ctx.platforms, {
      workerId: ctx.workerA,
      halt: 'after_intent',
    }).catch(caught => caught);

    expect(halted).toBeInstanceOf(SupervisionHalted);
    if (!(halted instanceof SupervisionHalted)) throw new Error('the holder should stop');

    expect(await openIntents(ctx.depsA)).toHaveLength(1);

    ctx.clock.advance(reaperIntervalMs);

    const next = await runReaper(ctx.depsB, ctx.platforms, { workerId: ctx.workerB });
    const planner = await ctx.depsB.store.session(defaultWorkspaceId, ctx.plannerId);

    expect(next.ran).toBe(true);
    expect(planner?.life).toBe('ended');
    expect(await openIntents(ctx.depsB)).toHaveLength(0);

    await expect(
      writeReaperWatch(ctx.depsA, halted.epoch, emptyWatch(ctx.plannerId, defaultWorkspaceId))
    ).rejects.toMatchObject({ code: 'conflict' });
  }
);

test.skipIf(databaseUrl === undefined)(
  'a counter repair waits for a transaction that holds the group',
  async () => {
    const ctx = await boot(databaseUrl ?? '');
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let locked = false;
    const holder = ctx.depsA.store.transact(async tx => {
      await tx.lockGroup(defaultWorkspaceId, ctx.groupId);
      locked = true;
      await gate;
    });
    let repair: Promise<void> = Promise.resolve();

    runAfterTest(async () => {
      release();
      await Promise.allSettled([holder, repair]);
    });
    await waitUntil(() => (locked ? true : null), 'the first transaction to lock the group');

    let repaired = false;

    repair = ctx.depsB.store
      .transact(tx => tx.correctCounters())
      .then(() => {
        repaired = true;
      });

    await waitUntil(
      () => ctx.blockedQueries().then(count => (count > 0 ? true : null)),
      'the repair to wait'
    );

    expect(repaired).toBe(false);

    release();
    await holder;
    await repair;

    expect(repaired).toBe(true);
  }
);

async function boot(url: string) {
  const setup = openPostgresStore(url);

  await setup.exec('DROP SCHEMA public CASCADE');
  await setup.exec('CREATE SCHEMA public');
  await setup.migrate();

  const clock = manualClock(new Date('2026-11-17T00:00:00.000Z'));
  const workerA = createWorkerId(systemRandom.bytes(8));
  const workerB = createWorkerId(systemRandom.bytes(8));
  const sql = new SQL(url);
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
  const context = {
    clock,
    platforms,
    groupId: opened.group.id,
    plannerId: opened.session.id,
    workerA,
    workerB,
    depsA: { ...deps, store: storeA },
    depsB: { ...deps, store: storeB },
    async holder(job: string) {
      const rows = await sql.unsafe('SELECT holder FROM leases WHERE job = $1', [job]);
      const row = Array.isArray(rows) ? rows[0] : undefined;

      return typeof row?.holder === 'string' ? row.holder : '';
    },
    async blockedQueries() {
      const rows = await sql.unsafe(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;

      return typeof row?.count === 'number' ? row.count : 0;
    },
    async close() {
      await storeA.close();
      await storeB.close();
      await setup.close();
      await sql.close();
    },
  };

  runAfterTest(() => context.close());

  return context;
}

function openIntents(deps: ServiceDeps) {
  return deps.store.transact(tx => tx.openIntents('reaper'));
}
