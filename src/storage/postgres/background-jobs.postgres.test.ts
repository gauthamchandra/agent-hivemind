import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { ServiceDeps } from '@/core/deps.ts';
import { createFirstAdministrator, openInstallation } from '@/core/installation.ts';
import { createWorkerId } from '@/core/job-run.ts';
import { runReaper } from '@/core/reaper.ts';
import { writeReaperJobState } from '@/core/reaper-actions.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { runUsagePoll } from '@/core/usage-poll.ts';
import {
  emptySessionJobState,
  reaperIntervalMs,
  usagePollIntervalMs,
} from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import { createIds, defaultWorkspaceId } from '@/domain/ids.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPostgresStore } from '@/storage/postgres/postgres.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { manualClock } from '@/testing/clock.ts';
import { testResponseKey } from '@/testing/deps.ts';
import { checkoutGroup } from '@/testing/fixtures.ts';
import { runAfterTest } from '@/testing/teardown.ts';
import { waitUntil } from '@/testing/wait.ts';

const databaseUrl = process.env.HIVEMIND_POSTGRES_URL;

test.skipIf(databaseUrl === undefined)(
  'two workers race for the usage poll job lock and one runs the job',
  async () => {
    const ctx = await boot(databaseUrl ?? '');
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    runAfterTest(() => release());

    let entered = false;
    const platforms = delaying(ctx.platforms, ctx.connectionId, async () => {
      entered = true;
      await gate;
    });
    const first = runUsagePoll(ctx.depsA, platforms, { workerId: ctx.workerA });

    await waitUntil(() => (entered ? true : null), 'the first worker to read usage');

    const second = await runUsagePoll(ctx.depsB, platforms, { workerId: ctx.workerB });

    release();

    const winner = await first;

    expect(winner.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(ctx.workerA).not.toBe(ctx.workerB);
    expect(await ctx.lockedBy('usage_poll')).toBe(ctx.workerA);
    expect(ctx.simulated.calls().filter(call => call === 'readUsage')).toHaveLength(1);
  }
);

test.skipIf(databaseUrl === undefined)(
  'the next worker writes status and usage after the first worker stops',
  async () => {
    const ctx = await boot(databaseUrl ?? '');
    const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

    ctx.simulated.setSessionUsage(ref, 2);

    const held = await runUsagePoll(ctx.depsA, ctx.platforms, { workerId: ctx.workerA });

    expect(held.ran).toBe(true);

    ctx.clock.advance(usagePollIntervalMs);
    ctx.simulated.setSessionStatus(ref, 'idle');
    ctx.simulated.setSessionUsage(ref, 7);

    const next = await runUsagePoll(ctx.depsB, ctx.platforms, { workerId: ctx.workerB });
    const stored = await ctx.depsA.store.session(defaultWorkspaceId, ctx.planner.id);

    expect(next.ran).toBe(true);
    expect(stored?.last_status).toBe('idle');
    expect(stored?.usage).toBe('7');
  }
);

test.skipIf(databaseUrl === undefined)(
  'two workers race for the reaper job lock and one runs the job',
  async () => {
    const ctx = await boot(databaseUrl ?? '');
    const [first, second] = await Promise.all([
      runReaper(ctx.depsA, ctx.platforms, { workerId: ctx.workerA }),
      runReaper(ctx.depsB, ctx.platforms, { workerId: ctx.workerB }),
    ]);

    expect([first.ran, second.ran].filter(ran => ran)).toHaveLength(1);
    expect([first.lockId, second.lockId].filter(lockId => lockId !== null)).toEqual([1]);
    expect([ctx.workerA, ctx.workerB]).toContain(await ctx.lockedBy('reaper'));
  }
);

test.skipIf(databaseUrl === undefined)(
  'an old lock id is rejected and the next worker finishes the open planned action',
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

    const stopped = await runReaper(ctx.depsA, ctx.platforms, {
      workerId: ctx.workerA,
      crashAt: 'after_planned_action',
    }).catch(caught => caught);

    expect(stopped).toBeInstanceOf(StoppedProcess);

    const oldLockId = await ctx.lockId('reaper');

    expect(await openPlannedActions(ctx.depsA)).toHaveLength(1);

    ctx.clock.advance(reaperIntervalMs);

    const next = await runReaper(ctx.depsB, ctx.platforms, { workerId: ctx.workerB });
    const planner = await ctx.depsB.store.session(defaultWorkspaceId, ctx.plannerId);

    expect(next.ran).toBe(true);
    expect(planner?.life).toBe('ended');
    expect(await openPlannedActions(ctx.depsB)).toHaveLength(0);

    await expect(
      writeReaperJobState(
        ctx.depsA,
        oldLockId,
        emptySessionJobState(ctx.plannerId, defaultWorkspaceId)
      )
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
    idempotencyKey: 'pg-background-jobs',
    bodyHash: 'pg-background-jobs',
  });

  expect(opened.outcome).toBe('live');
  if (opened.outcome !== 'live') throw new Error('planner did not start');

  const storeA = openPostgresStore(url);
  const storeB = openPostgresStore(url);
  const context = {
    clock,
    platforms,
    simulated,
    connectionId,
    planner: opened.session,
    groupId: opened.group.id,
    plannerId: opened.session.id,
    workerA,
    workerB,
    depsA: { ...deps, store: storeA },
    depsB: { ...deps, store: storeB },
    async lockId(job: string) {
      const rows = await sql.unsafe('SELECT lock_id FROM job_locks WHERE job = $1', [job]);
      const row = Array.isArray(rows) ? rows[0] : undefined;

      return Number(row?.lock_id ?? 0);
    },
    async lockedBy(job: string) {
      const rows = await sql.unsafe('SELECT locked_by FROM job_locks WHERE job = $1', [job]);
      const row = Array.isArray(rows) ? rows[0] : undefined;

      return typeof row?.locked_by === 'string' ? row.locked_by : '';
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

function openPlannedActions(deps: ServiceDeps) {
  return deps.store.transact(tx => tx.openPlannedActions('reaper'));
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
