import { expect, test } from 'bun:test';
import type { ServiceDeps } from '@/core/deps.ts';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { reportTransition } from '@/core/report-records.ts';
import { openGroup } from '@/core/session-open.ts';
import { startSession } from '@/core/session-start.ts';
import { createChildTask } from '@/core/task-records.ts';
import { HivemindError } from '@/domain/errors.ts';
import { createIds, defaultWorkspaceId } from '@/domain/ids.ts';
import { selfHostedGroupCaps } from '@/domain/model.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPostgresStore } from '@/storage/postgres/postgres.ts';
import { manualClock } from '@/testing/clock.ts';
import { testResponseKey } from '@/testing/deps.ts';

const databaseUrl = process.env.HIVEMIND_POSTGRES_URL;

test.skipIf(databaseUrl === undefined)(
  'two PostgreSQL clients take one live-session place',
  async () => {
    const url = databaseUrl ?? '';
    const setup = openPostgresStore(url);

    await setup.exec('DROP SCHEMA public CASCADE');
    await setup.exec('CREATE SCHEMA public');
    await setup.migrate();

    const clock = manualClock(new Date('2026-11-16T00:00:00.000Z'));
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

    await createOperatorKey(deps, {
      bootstrapSecret: secret,
      name: 'creator',
      role: 'creator',
      expiresAt: null,
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
    const opened = await openGroup(deps, platforms, {
      workspaceId: defaultWorkspaceId,
      personId: admin.id,
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      connectionId,
      verificationMode: 'before_merge',
      notes: [],
      instructions: 'Plan the work.',
      idempotencyKey: 'pg-group',
      bodyHash: 'pg-group',
    });

    expect(opened.outcome).toBe('live');

    if (opened.outcome !== 'live') throw new Error('planner did not start');

    await reportTransition(deps, {
      workspaceId: defaultWorkspaceId,
      groupId: opened.group.id,
      taskId: opened.root.id,
      expectedVersion: opened.root.version,
      actor: { kind: 'session', role: 'planner', sessionId: opened.session.id, live: true },
      to: 'analyzing',
      note: 'The plan is underway.',
      evidence: [],
      nextVerificationMode: null,
    });

    const left = await createChildTask(deps, {
      workspaceId: defaultWorkspaceId,
      groupId: opened.group.id,
      actor: { sessionId: opened.session.id, live: true },
      title: 'Left task',
      description: 'A child task with enough description to be stored.',
      verificationMode: null,
      dependsOn: [],
    });
    const right = await createChildTask(deps, {
      workspaceId: defaultWorkspaceId,
      groupId: opened.group.id,
      actor: { sessionId: opened.session.id, live: true },
      title: 'Right task',
      description: 'A child task with enough description to be stored.',
      verificationMode: null,
      dependsOn: [],
    });

    await raceLastPlace(url, setup, deps, platforms, opened, left, right);
  }
);

async function raceLastPlace(
  url: string,
  setup: ReturnType<typeof openPostgresStore>,
  deps: ServiceDeps,
  platforms: Platforms,
  opened: Awaited<ReturnType<typeof openGroup>>,
  left: Awaited<ReturnType<typeof createChildTask>>,
  right: Awaited<ReturnType<typeof createChildTask>>
): Promise<void> {
  await setup.exec(
    `UPDATE groups SET caps = '${JSON.stringify({ ...selfHostedGroupCaps, live_sessions: 2 })}'::jsonb WHERE id = '${opened.group.id}'`
  );

  const leftStore = openPostgresStore(url);
  const rightStore = openPostgresStore(url);
  const leftDeps: ServiceDeps = { ...deps, store: leftStore };
  const rightDeps: ServiceDeps = { ...deps, store: rightStore };
  const results = await Promise.allSettled([
    startSession(leftDeps, platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: opened.group.id,
      taskId: left.task.id,
      role: 'implementer',
      instructions: 'Take the left task.',
      actor: { kind: 'session', sessionId: opened.session.id },
      idempotencyKey: 'pg-left',
      bodyHash: 'pg-left',
      replacementOf: null,
    }),
    startSession(rightDeps, platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: opened.group.id,
      taskId: right.task.id,
      role: 'implementer',
      instructions: 'Take the right task.',
      actor: { kind: 'session', sessionId: opened.session.id },
      idempotencyKey: 'pg-right',
      bodyHash: 'pg-right',
      replacementOf: null,
    }),
  ]);

  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);

  const failure = results.find(result => result.status === 'rejected');

  if (failure?.status !== 'rejected') throw new Error('one start should lose the place');

  expect(failure.reason).toBeInstanceOf(HivemindError);
  expect((failure.reason as HivemindError).code).toBe('cap_reached');

  const occupancy = await setup.occupancy(defaultWorkspaceId, opened.group.id);

  expect(occupancy.live_sessions).toBe(2);

  await leftStore.close();
  await rightStore.close();
  await setup.close();
}
