import { expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import type { ServiceDeps } from '@/core/deps.ts';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { reportTransition } from '@/core/report-records.ts';
import { addTaskNote, editChildTask } from '@/core/session-activity.ts';
import { endSession, resumeEnd } from '@/core/session-end.ts';
import { enroll } from '@/core/session-enroll.ts';
import { openGroup } from '@/core/session-open.ts';
import { releaseSession, resumeSession } from '@/core/session-release.ts';
import { recoverStart, startSession } from '@/core/session-start.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { createChildTask } from '@/core/task-records.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  defaultWorkspaceId,
  type GroupId,
  requireSessionId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
} from '@/domain/ids.ts';
import { selfHostedGroupCaps } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { PlatformAdapter, StartSessionInput } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService, type Service } from '@/testing/boot.ts';
import { checkoutGroup, note } from '@/testing/fixtures.ts';
import {
  createTestPlatforms,
  enrollmentCodeIn,
  promptMentioning,
  replaceAdapter,
} from '@/testing/platforms.ts';
import { waitUntil } from '@/testing/wait.ts';

async function boot() {
  const service = await bootService();
  const { deps } = service;
  const installation = await openInstallation(deps);
  const secret = requirePresent(
    installation.bootstrapSecret,
    'the empty store should print a bootstrap key'
  );
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

  return { ...service, admin };
}

async function withPlanner() {
  const ctx = await boot();
  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    ...checkoutGroup,
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'open-group',
    bodyHash: 'open-group-body',
  });

  expect(opened.outcome).toBe('live');

  if (opened.outcome !== 'live') throw new Error('planner did not start');

  const token = requirePresent(
    ctx.simulated.secretFor(opened.session.id),
    'the planner should receive a secret'
  );

  expect(ctx.simulated.prompts().join('\n')).not.toContain(token);

  return { ...ctx, opened, planner: opened.session };
}

async function childTask(
  deps: ServiceDeps,
  groupId: GroupId,
  plannerId: SessionId,
  title: string
): Promise<TaskId> {
  const tasks = await deps.store.tasks(defaultWorkspaceId, groupId);
  const root = tasks.find(task => task.parent_id === null);

  if (root?.state === 'planned') {
    await reportTransition(deps, {
      workspaceId: defaultWorkspaceId,
      groupId,
      taskId: root.id,
      expectedVersion: root.version,
      actor: { kind: 'session', role: 'planner', sessionId: plannerId, live: true },
      to: 'analyzing',
      note,
      evidence: [],
      nextVerificationMode: null,
    });
  }

  const created = await createChildTask(deps, {
    workspaceId: defaultWorkspaceId,
    groupId,
    actor: { sessionId: plannerId, live: true },
    title,
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
  });

  return created.task.id;
}

async function setCaps(
  db: PGlite,
  groupId: string,
  caps: typeof selfHostedGroupCaps
): Promise<void> {
  await db.query('UPDATE groups SET caps = $1::jsonb WHERE id = $2', [
    JSON.stringify(caps),
    groupId,
  ]);
}

function watchGroupAndTasks(tx: UnitOfWork, order: string[]): UnitOfWork {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'lockGroup' || prop === 'lockTask') {
        return async (...args: unknown[]) => {
          order.push(prop === 'lockGroup' ? 'group' : String(args[1]));

          const method = Reflect.get(target, prop, receiver) as (
            ...methodArgs: unknown[]
          ) => Promise<unknown>;

          return method.apply(target, args);
        };
      }

      const value = Reflect.get(target, prop, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function watchTaskIds(tx: UnitOfWork, order: string[]): UnitOfWork {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'lockTask') {
        return async (...args: unknown[]) => {
          order.push(String(args[1]));

          const method = Reflect.get(target, prop, receiver) as (
            ...methodArgs: unknown[]
          ) => Promise<unknown>;

          return method.apply(target, args);
        };
      }

      const value = Reflect.get(target, prop, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function watchLocks(tx: UnitOfWork, order: string[]): UnitOfWork {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'lockTask' || prop === 'lockSession') {
        return async (...args: unknown[]) => {
          order.push(prop === 'lockTask' ? 'task' : 'session');

          const method = Reflect.get(target, prop, receiver) as (
            ...methodArgs: unknown[]
          ) => Promise<unknown>;

          return method.apply(target, args);
        };
      }

      const value = Reflect.get(target, prop, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function expectBalanced(
  deps: ServiceDeps,
  workspaceId: WorkspaceId,
  groupId: GroupId,
  terminals: { id: SessionId; life: 'ended' | 'start_failed' }[]
): Promise<void> {
  const sessions = await deps.store.sessions(workspaceId, groupId);
  const holding = sessions.filter(
    session => session.life === 'starting' || session.life === 'live'
  );
  const occupancy = await deps.store.occupancy(workspaceId, groupId);

  expect(occupancy.live_sessions).toBe(holding.length);

  for (const expected of terminals) {
    const session = sessions.find(item => item.id === expected.id);

    expect(session?.life).toBe(expected.life);
    expect(session?.token_hash).toBeNull();
  }
}

test('two overlapping starts take one place', async () => {
  const ctx = await withPlanner();
  const left = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Left task');
  const right = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Right task');

  await setCaps(ctx.db, ctx.opened.group.id, { ...selfHostedGroupCaps, live_sessions: 2 });

  const results = await Promise.allSettled([
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId: left,
      role: 'implementer',
      instructions: 'Take the left task.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: 'left',
      bodyHash: 'left',
      replacementOf: null,
    }),
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId: right,
      role: 'implementer',
      instructions: 'Take the right task.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: 'right',
      bodyHash: 'right',
      replacementOf: null,
    }),
  ]);

  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  const failure = rejected[0];

  if (failure?.status !== 'rejected') throw new Error('the losing start should reject');

  expect(failure.reason).toBeInstanceOf(HivemindError);
  expect((failure.reason as HivemindError).code).toBe('cap_reached');
  expect((failure.reason as HivemindError).details.cap).toBe('live_sessions');

  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);
  const sessions = await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id);
  const holding = sessions.filter(
    session => session.life === 'starting' || session.life === 'live'
  );

  expect(occupancy.live_sessions).toBe(2);
  expect(holding).toHaveLength(2);
});
test('a refused start returns its places and keeps the spawn-rate count', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Refused task');
  const before = await ctx.deps.store.spawnCount(ctx.opened.group.id, '2026-11-15T00:00:00.000Z');

  ctx.simulated.queueError('start', 'auth');

  const refused = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'This start is refused.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'refused',
    bodyHash: 'refused',
    replacementOf: null,
  });

  expect(refused.outcome).toBe('refused');
  expect(refused.session.life).toBe('start_failed');
  expect(refused.session.token_hash).toBeNull();

  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(occupancy.live_sessions).toBe(1);

  const after = await ctx.deps.store.spawnCount(ctx.opened.group.id, '2026-11-15T00:00:00.000Z');

  expect(after).toBe(before + 1);

  await setCaps(ctx.db, ctx.opened.group.id, { ...selfHostedGroupCaps, spawn_rate: after });

  const blocked = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'The rate count is still spent.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'rate',
    bodyHash: 'rate',
    replacementOf: null,
  });

  await expect(blocked).rejects.toMatchObject({
    code: 'cap_reached',
    details: { cap: 'spawn_rate', limit: after, current: after },
  });
});
test('an unavailable start stays starting and find-by-key completes it', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Pending task');

  ctx.simulated.loseNextStartResponse();

  const pending = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'The platform answer is lost.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'pending',
    bodyHash: 'pending',
    replacementOf: null,
  });

  expect(pending.outcome).toBe('start_pending');
  expect(pending.session.life).toBe('starting');

  const held = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(held.live_sessions).toBe(2);

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: pending.session.id,
  });

  expect(recovered.life).toBe('live');
  expect(recovered.platform_session_ref).not.toBeNull();
});
test('find-by-key absent compensates a start the platform did not create', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Absent task');

  ctx.simulated.queueError('start', 'unavailable');

  const pending = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'The platform timed out before creating a session.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'absent',
    bodyHash: 'absent',
    replacementOf: null,
  });

  expect(pending.session.life).toBe('starting');

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: pending.session.id,
  });

  expect(recovered.life).toBe('start_failed');

  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(occupancy.live_sessions).toBe(1);
  expect(await ctx.deps.store.spawnCount(ctx.opened.group.id, '2026-11-15T00:00:00.000Z')).toBe(2);
});

test('a stop between start steps and end steps leaves places matching sessions', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Crash task');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Stop between the steps.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    replacementOf: null,
  };

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      ...input,
      idempotencyKey: 'crash-reserve',
      bodyHash: 'crash-reserve',
      crashAt: 'after_reserve',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  let sessions = await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id);
  const reserved = requirePresent(
    sessions.find(session => session.role === 'implementer'),
    'the reserved session should be stored'
  );

  const compensated = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  expect(compensated.life).toBe('start_failed');
  await expectBalanced(ctx.deps, defaultWorkspaceId, ctx.opened.group.id, [
    { id: compensated.id, life: 'start_failed' },
  ]);

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      ...input,
      idempotencyKey: 'crash-accept',
      bodyHash: 'crash-accept',
      crashAt: 'after_platform_accept',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  sessions = await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id);
  const accepted = requirePresent(
    sessions.find(session => session.role === 'implementer' && session.life === 'starting'),
    'the accepted start should still be starting'
  );

  const live = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: accepted.id,
  });

  expect(live.life).toBe('live');
  await expectBalanced(ctx.deps, defaultWorkspaceId, ctx.opened.group.id, [
    { id: compensated.id, life: 'start_failed' },
  ]);

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: live.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'Stop after the ending intent.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const intended = await ctx.deps.store.session(defaultWorkspaceId, live.id);

  expect(intended?.token_hash).not.toBeNull();
  expect(intended?.life).toBe('live');

  const ended = await resumeEnd(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: live.id,
  });

  expect(ended.life).toBe('ended');
  await expectBalanced(ctx.deps, defaultWorkspaceId, ctx.opened.group.id, [
    { id: compensated.id, life: 'start_failed' },
    { id: live.id, life: 'ended' },
  ]);

  const again = await startSession(ctx.deps, ctx.platforms, {
    ...input,
    idempotencyKey: 'crash-end-platform',
    bodyHash: 'crash-end-platform',
    replacementOf: live.id,
  });

  expect(again.outcome).toBe('live');

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: again.session.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'Stop after the platform end.',
      crashAt: 'after_platform_end',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const finished = await resumeEnd(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: again.session.id,
  });

  expect(finished.life).toBe('ended');
  await expectBalanced(ctx.deps, defaultWorkspaceId, ctx.opened.group.id, [
    { id: compensated.id, life: 'start_failed' },
    { id: live.id, life: 'ended' },
    { id: again.session.id, life: 'ended' },
  ]);
});

test('a late platform reference is stopped and its usage is read', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late stop');
  const held = holdPlatform(ctx);
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'late-stop',
    bodyHash: 'late-stop',
    replacementOf: null,
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop before the platform answers.',
  });
  ctx.simulated.controls.setReportedUsage(4);
  held.release();

  const started = await pending;
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const session = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(session)
  );

  expect(started.outcome).toBe('ended');
  expect(session?.final_usage_pending).toBe(false);
  expect(group?.spend).toBe('4');
  expect(status.status).toBe('stopped');
});

test('a failed late stop stays retryable from resume', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late retry');
  const held = holdPlatform(ctx, { failEnds: 1 });
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'late-retry',
    bodyHash: 'late-retry',
    replacementOf: null,
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop before the platform answers.',
  });
  held.release();

  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });

  const unfinished = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const stillRunning = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(unfinished)
  );

  expect(unfinished?.life).toBe('ended');
  expect(unfinished?.final_usage_pending).toBe(true);
  expect(stillRunning.status).toBe('working');

  ctx.simulated.controls.setReportedUsage(4);

  const resumed = await resumeEnd(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(resumed)
  );

  expect(resumed.final_usage_pending).toBe(false);
  expect(group?.spend).toBe('4');
  expect(status.status).toBe('stopped');
});

test('a repeated end stops a platform session before it clears pending usage', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Stop then read');
  const held = holdPlatform(ctx, { failEnds: 1 });
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'stop-then-read',
    bodyHash: 'stop-then-read',
    replacementOf: null,
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop before the platform answers.',
  });
  held.release();
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });

  const unfinished = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const stillRunning = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(unfinished)
  );

  expect(unfinished?.final_usage_pending).toBe(true);
  expect(stillRunning.status).toBe('working');

  ctx.simulated.controls.setReportedUsage(4);

  const again = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop the session that is still running.',
  });
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(again)
  );

  expect(status.status).toBe('stopped');
  expect(again.final_usage_pending).toBe(false);
  expect(again.usage).toBe('4');
});

test('a prompt does not stop when an environment report cannot be sent', async () => {
  const ctx = await withPlanner();
  const prompt = requirePresent(
    ctx.simulated.prompts()[0],
    'the platform should have been prompted'
  );

  expect(prompt).not.toContain('If the report fails, stop');
  expect(prompt).not.toContain('do not report completion');
});

test('a tiny usage reading is stored', async () => {
  const ctx = await withPlanner();

  ctx.simulated.controls.setReportedUsage(0.0000001);
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The reading is a small fraction.',
  });

  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(group?.spend).toBe('0.0000001');
});

test('a second end stops before it records pending usage', async () => {
  const ctx = await withPlanner();

  ctx.simulated.controls.setReportedUsage(4);
  ctx.simulated.queueError('readUsage', 'unavailable');
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The usage read failed.',
  });

  const pending = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const ends = ctx.simulated.calls().filter(call => call === 'end').length;

  expect(pending?.life).toBe('ended');
  expect(pending?.final_usage_pending).toBe(true);

  const again = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Read the usage that was missed.',
  });
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(again.final_usage_pending).toBe(false);
  expect(again.usage).toBe('4');
  expect(group?.spend).toBe('4');
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(ends + 1);
});

test('an end stops a reference attached while find is in flight', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late reference');
  const found = holdFind(ctx);
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Write the change.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'late-ref',
    bodyHash: 'late-ref',
    replacementOf: null,
    crashAt: 'after_reserve' as const,
  };

  await expect(startSession(ctx.deps, ctx.platforms, input)).rejects.toBeInstanceOf(StoppedProcess);

  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  const ending = endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop while the platform is still unknown.',
  });

  await found.entered;
  await ctx.db.query('UPDATE sessions SET platform_session_ref = $1 WHERE id = $2', [
    'plat_late',
    reserved.id,
  ]);
  found.release();

  await ending;

  expect(found.ended).toContain('plat_late');
});

test('a repeated release and resume keep the same place count', async () => {
  const ctx = await withPlanner();
  const release = {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    idempotency: { key: 'release-once', bodyHash: 'release-once' },
  };
  const released = await releaseSession(ctx.deps, release);
  const releasedAgain = await releaseSession(ctx.deps, release);
  const afterRelease = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);
  const resume = {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    idempotency: { key: 'resume-once', bodyHash: 'resume-once' },
  };
  const resumed = await resumeSession(ctx.deps, resume);
  const resumedAgain = await resumeSession(ctx.deps, resume);
  const afterResume = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(released.life).toBe('released');
  expect(releasedAgain.life).toBe('released');
  expect(afterRelease.live_sessions).toBe(0);
  expect(resumed.life).toBe('live');
  expect(resumedAgain.life).toBe('live');
  expect(afterResume.live_sessions).toBe(1);
});
test('release frees places and resume takes them back without a platform call', async () => {
  const ctx = await withPlanner();
  const before = ctx.simulated.calls().length;
  const released = await releaseSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
  });

  expect(released.life).toBe('released');
  expect(ctx.simulated.calls().length).toBe(before);

  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(occupancy.live_sessions).toBe(0);
  expect(occupancy.total_sessions).toBe(1);

  const resumed = await resumeSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
  });

  expect(resumed.life).toBe('live');
  expect(ctx.simulated.calls().length).toBe(before);

  const after = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(after.live_sessions).toBe(1);
  expect(after.total_sessions).toBe(1);
  expect(await ctx.deps.store.spawnCount(ctx.opened.group.id, '2026-11-15T00:00:00.000Z')).toBe(1);
});
test('opening a group again with the same key returns the same group and planner', async () => {
  const ctx = await boot();
  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Checkout',
    goal: 'Move tax calculation behind an interface.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge' as const,
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'same-group',
    bodyHash: 'same-body',
  };
  const first = await openGroup(ctx.deps, ctx.platforms, input);
  const second = await openGroup(ctx.deps, ctx.platforms, input);
  const counted = await ctx.db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM groups'
  );

  expect(second.group.id).toBe(first.group.id);
  expect(second.session.id).toBe(first.session.id);
  expect(counted.rows[0]?.count).toBe(1);
});
test('an overlapping start with the same key replays the reserved session', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'One place');

  await setCaps(ctx.db, ctx.opened.group.id, { ...selfHostedGroupCaps, live_sessions: 2 });

  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Take the only place.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'same-start',
    bodyHash: 'same-start',
    replacementOf: null,
  };
  const results = await Promise.allSettled([
    startSession(ctx.deps, ctx.platforms, input),
    startSession(ctx.deps, ctx.platforms, input),
  ]);

  expect(results.every(result => result.status === 'fulfilled')).toBe(true);

  const sessions = results.flatMap(result =>
    result.status === 'fulfilled' ? [result.value.session.id] : []
  );

  expect(sessions[0]).toBe(sessions[1]);
});
test('a final usage reading is added to spend once', async () => {
  const ctx = await withPlanner();

  ctx.simulated.controls.setReportedUsage(4);

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The plan is finished.',
  });

  const first = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(first?.spend).toBe('4');

  await ctx.db.query('UPDATE sessions SET final_usage_pending = true WHERE id = $1', [
    ctx.planner.id,
  ]);
  await resumeEnd(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
  });

  const second = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(second?.spend).toBe('4');
});

test('completing a start after an end intent stops the platform session', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(
    ctx.deps,
    ctx.opened.group.id,
    ctx.planner.id,
    'Ended during start'
  );

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId,
      role: 'implementer',
      instructions: 'Stop after the platform accepts.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: 'end-during-start',
      bodyHash: 'end-during-start',
      replacementOf: null,
      crashAt: 'after_platform_accept',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const starting = requirePresent(
    (await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id)).find(
      session => session.role === 'implementer'
    ),
    'the implementer should be stored'
  );

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: starting.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'Stop before the start is recorded as live.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: starting.id,
  });

  expect(recovered.life).toBe('ended');
  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBeGreaterThan(0);
});
test('replaying a finished start does not report the session as live', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Replay after end');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Write the change.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'replay-ended',
    bodyHash: 'replay-ended',
    replacementOf: null,
  };
  const started = await startSession(ctx.deps, ctx.platforms, input);

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The work is done.',
  });

  const replay = await startSession(ctx.deps, ctx.platforms, input);

  expect(replay.session.id).toBe(started.session.id);
  expect(replay.outcome).toBe('ended');
});

test('a replay of a failed start stops the platform session that is still running', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Failed replay');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'The platform accepted and the start was compensated.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'failed-replay',
    bodyHash: 'failed-replay',
    replacementOf: null,
    crashAt: 'after_platform_accept' as const,
  };

  await expect(startSession(ctx.deps, ctx.platforms, input)).rejects.toBeInstanceOf(StoppedProcess);

  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await ctx.db.query(`UPDATE sessions SET life = 'start_failed' WHERE id = $1`, [reserved.id]);
  ctx.simulated.queueError('end', 'unavailable');
  await expect(
    recoverStart(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: reserved.id,
    })
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'The platform did not stop the session.',
  });

  const replay = await startSession(ctx.deps, ctx.platforms, input);
  const settled = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(settled)
  );

  expect(replay.outcome).toBe('refused');
  expect(settled?.life).toBe('start_failed');
  expect(settled?.final_usage_pending).toBe(false);
  expect(status.status).toBe('stopped');
});

test('a replay of an ended start finishes a pending usage read', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Ended replay');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Write the change.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'ended-usage-replay',
    bodyHash: 'ended-usage-replay',
    replacementOf: null,
  };
  const started = await startSession(ctx.deps, ctx.platforms, input);

  ctx.simulated.controls.setReportedUsage(4);
  ctx.simulated.queueError('readUsage', 'unavailable');
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The usage read failed.',
  });

  const replay = await startSession(ctx.deps, ctx.platforms, input);

  expect(replay.outcome).toBe('ended');
  expect(replay.session.final_usage_pending).toBe(false);
  expect(replay.session.usage).toBe('4');
});

test('a replay of an ended start stops a platform session that appears later', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late replay');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'The platform has not accepted yet.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'late-replay',
    bodyHash: 'late-replay',
    replacementOf: null,
    crashAt: 'after_reserve' as const,
  };

  await expect(startSession(ctx.deps, ctx.platforms, input)).rejects.toBeInstanceOf(StoppedProcess);

  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The platform had not accepted.',
  });
  await acceptAfterEnd(ctx, { id: reserved.id, title: 'Late replay' });

  const replay = await startSession(ctx.deps, ctx.platforms, input);

  expect(replay.outcome).toBe('ended');
  expect(replay.session.platform_session_ref).not.toBeNull();
  expect(replay.session.final_usage_pending).toBe(false);

  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(replay.session)
  );

  expect(status.status).toBe('stopped');
});

test('a final reading above the budget is stored and blocks the next start', async () => {
  const ctx = await withPlanner();

  await ctx.db.query('UPDATE groups SET budget = $1::numeric WHERE id = $2', [
    '3',
    ctx.opened.group.id,
  ]);
  ctx.simulated.controls.setReportedUsage(4);
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The plan used more than the budget.',
  });

  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(group?.spend).toBe('4');

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId: ctx.opened.root.id,
      role: 'planner',
      instructions: 'This start is past the budget.',
      actor: { kind: 'person', personId: ctx.admin.id },
      idempotencyKey: 'over-budget',
      bodyHash: 'over-budget',
      replacementOf: null,
    })
  ).rejects.toMatchObject({ code: 'cap_reached' });
});
test('ending a start whose reply was lost stops that platform session', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Lost reply');

  ctx.simulated.loseNextStartResponse();

  const pending = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'The platform accepts and the reply is lost.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'lost-reply',
    bodyHash: 'lost-reply',
    replacementOf: null,
  });

  expect(pending.outcome).toBe('start_pending');

  const ended = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: pending.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop the session the platform already accepted.',
  });
  const found = await ctx.simulated.adapter.findByKey(
    ctx.simulated.connection(),
    pending.session.id,
    pending.session.created_at
  );

  expect(ended.life).toBe('ended');
  expect(found.outcome).toBe('found');

  if (found.outcome !== 'found') throw new Error('the platform session should still be findable');

  expect(
    await ctx.simulated.adapter.send(ctx.simulated.connection(), found.platformSessionRef, 'ping')
  ).toBe('gone');
});
test('a retry of a lost start recovers the platform session', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Lost start');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'The platform accepts and the reply is lost.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'lost-start-retry',
    bodyHash: 'lost-start-retry',
    replacementOf: null,
  };

  ctx.simulated.loseNextStartResponse();

  const pending = await startSession(ctx.deps, ctx.platforms, input);
  const again = await startSession(ctx.deps, ctx.platforms, input);

  expect(pending.outcome).toBe('start_pending');
  expect(again.outcome).toBe('live');
  expect(again.session.id).toBe(pending.session.id);
  expect(again.session.platform_session_ref).not.toBeNull();
});
test('a retry stays pending while the first start is still in flight', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Still starting');
  const held = holdPlatform(ctx);
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Wait for the platform.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'in-flight',
    bodyHash: 'in-flight',
    replacementOf: null,
  };
  const first = startSession(ctx.deps, ctx.platforms, input);
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  const again = await startSession(ctx.deps, ctx.platforms, input);
  const during = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);

  expect(again.outcome).toBe('start_pending');
  expect(during?.life).toBe('starting');
  expect(during?.token_hash).not.toBeNull();

  held.release();

  const started = await first;
  const sent = await ctx.simulated.adapter.send(
    ctx.simulated.connection(),
    platformRefOf(started.session),
    'still running'
  );

  expect(started.outcome).toBe('live');
  expect(sent).not.toBe('gone');
});

test('a repeated open stays pending while the planner start is in flight', async () => {
  const ctx = await boot();
  const held = holdPlatform(ctx);
  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Checkout',
    goal: 'Move tax calculation behind an interface.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: null,
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'open-in-flight',
    bodyHash: 'open-in-flight',
  };
  const first = openGroup(ctx.deps, ctx.platforms, input);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await ctx.db.query<{ life: string }>(
      "SELECT life FROM sessions WHERE role = 'planner'"
    );

    if (rows.rows.some(row => row.life === 'starting')) break;

    if (attempt === 49) throw new Error('the planner start did not reserve a row');
  }

  const again = await openGroup(ctx.deps, ctx.platforms, input);
  const group = await ctx.deps.store.group(defaultWorkspaceId, again.group.id);

  expect(again.outcome).toBe('start_pending');
  expect(group?.status).toBe('open');

  held.release();

  const opened = await first;

  expect(opened.outcome).toBe('live');
  expect(opened.group.status).toBe('open');
});

test('an implementer confirms an end recorded by someone else', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Open work');
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'ended-by-planner',
    bodyHash: 'ended-by-planner',
    replacementOf: null,
  });

  ctx.simulated.queueError('readUsage', 'unavailable');
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The planner ended this session.',
  });

  const pending = await ctx.deps.store.session(defaultWorkspaceId, started.session.id);

  expect(pending?.life).toBe('ended');
  expect(pending?.final_usage_pending).toBe(true);

  const confirmed = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
    actor: { kind: 'session', sessionId: started.session.id },
    reason: 'The receipt confirms the saved end.',
  });
  const stored = await ctx.deps.store.session(defaultWorkspaceId, started.session.id);

  expect(confirmed.life).toBe('ended');
  expect(stored?.final_usage_pending).toBe(false);
});

test('a retry of an open whose planner reply was lost recovers that start', async () => {
  const ctx = await boot();
  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Checkout',
    goal: 'Move tax calculation behind an interface.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge' as const,
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'lost-planner-open',
    bodyHash: 'lost-planner-open',
  };

  ctx.simulated.loseNextStartResponse();

  const pending = await openGroup(ctx.deps, ctx.platforms, input);
  const again = await openGroup(ctx.deps, ctx.platforms, input);

  expect(pending.outcome).toBe('start_pending');
  expect(again.outcome).toBe('live');
  expect(again.session.id).toBe(pending.session.id);
  expect(again.session.platform_session_ref).not.toBeNull();
});
test('a platform stop failure says the platform did not stop the session', async () => {
  const ctx = await withPlanner();

  ctx.simulated.queueError('end', 'unavailable');

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'The platform does not stop.',
    })
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'The platform did not stop the session.',
  });

  const session = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(session?.life).toBe('live');
});

test('an ended row stops a platform session that appears later', async () => {
  const ctx = await withPlanner();
  const reserved = await endedBeforePlatformAccept(ctx, 'Late accept');

  ctx.simulated.controls.setReportedUsage(4);
  await acceptAfterEnd(ctx, reserved);

  const again = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop the session the platform accepted later.',
  });
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(again.life).toBe('ended');
  expect(again.platform_session_ref).not.toBeNull();
  expect(again.final_usage_pending).toBe(false);
  expect(again.usage).toBe('4');
  expect(group?.spend).toBe('4');
  expect(
    await ctx.simulated.adapter.send(ctx.simulated.connection(), platformRefOf(again), 'ping')
  ).toBe('gone');
});
test('a failed stop of a late platform session stays pending', async () => {
  const ctx = await withPlanner();
  const reserved = await endedBeforePlatformAccept(ctx, 'Late stop fails');

  await acceptAfterEnd(ctx, reserved);
  ctx.simulated.queueError('end', 'unavailable');

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: reserved.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'The stop did not finish.',
    })
  ).rejects.toMatchObject({ code: 'unavailable' });

  const pending = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);

  expect(pending?.life).toBe('ended');
  expect(pending?.platform_session_ref).not.toBeNull();
  expect(pending?.final_usage_pending).toBe(true);
  expect(
    await ctx.simulated.adapter.readStatus(ctx.simulated.connection(), platformRefOf(pending))
  ).toEqual({ status: 'working' });
});
test('a failed usage read of a late platform session stays pending', async () => {
  const ctx = await withPlanner();
  const reserved = await endedBeforePlatformAccept(ctx, 'Late read fails');

  ctx.simulated.controls.setReportedUsage(4);
  await acceptAfterEnd(ctx, reserved);
  ctx.simulated.queueError('readUsage', 'unavailable');

  const stopped = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The usage read did not finish.',
  });

  expect(stopped.platform_session_ref).not.toBeNull();
  expect(stopped.final_usage_pending).toBe(true);

  const again = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Read the usage that was missed.',
  });

  expect(again.final_usage_pending).toBe(false);
  expect(again.usage).toBe('4');
});
test('a member cannot read an ended session from another group', async () => {
  const first = await withPlanner();

  await endSession(first.deps, first.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: first.planner.id,
    actor: { kind: 'person', personId: first.admin.id },
    reason: 'The first plan is finished.',
  });

  const second = await openGroup(first.deps, first.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: first.admin.id,
    name: 'Other',
    goal: 'A second group with its own planner.',
    budget: '100',
    connectionId: first.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the other work.',
    idempotencyKey: 'other-group',
    bodyHash: 'other-group',
  });

  await expect(
    endSession(first.deps, first.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: first.planner.id,
      actor: { kind: 'session', sessionId: second.session.id },
      reason: 'Read a session from another group.',
    })
  ).rejects.toMatchObject({ code: 'not_found' });

  const again = await endSession(first.deps, first.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: first.planner.id,
    actor: { kind: 'person', personId: first.admin.id },
    reason: 'The first plan is finished.',
  });

  expect(again.life).toBe('ended');
  expect(again.end_reason).toBe('The first plan is finished.');
});

test('an unavailable start does not report pending after the session has ended', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(
    ctx.deps,
    ctx.opened.group.id,
    ctx.planner.id,
    'End during silence'
  );
  const platforms = createTestPlatforms(ctx.connectionId, ctx.simulated, {
    ...ctx.simulated.adapter,
    start(_connection, input: StartSessionInput) {
      return endSession(ctx.deps, ctx.platforms, {
        workspaceId: defaultWorkspaceId,
        sessionId: input.tags.sessionId as SessionId,
        actor: { kind: 'session', sessionId: ctx.planner.id },
        reason: 'Stop the start that has not answered.',
      }).then(() => {
        throw new PlatformError('unavailable', 'The platform did not answer.');
      });
    },
  });
  const result = await startSession(ctx.deps, platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'The platform does not answer.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'silent-start',
    bodyHash: 'silent-start',
    replacementOf: null,
  });

  expect(result.outcome).not.toBe('start_pending');
  expect(result.session.life).toBe('ended');
});
test('five wrong enrollment codes void the code', async () => {
  const ctx = await boot();

  ctx.simulated.drop('secret_injection');

  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Cutoff',
    goal: 'Stop a code after five wrong attempts.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'cutoff-group',
    bodyHash: 'cutoff-group',
  });
  const prompt = promptMentioning(ctx.simulated, opened.session.id);
  const code = enrollmentCodeIn(prompt);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(
      enroll(ctx.deps, {
        sessionId: opened.session.id,
        code: 'enr_wrong',
        idempotencyKey: `cutoff-wrong-${attempt}`,
        bodyHash: `cutoff-wrong-${attempt}`,
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  }

  await expect(
    enroll(ctx.deps, {
      sessionId: opened.session.id,
      code,
      idempotencyKey: 'cutoff-real',
      bodyHash: 'cutoff-real',
    })
  ).rejects.toMatchObject({ code: 'unauthenticated' });

  const session = await ctx.deps.store.session(defaultWorkspaceId, opened.session.id);

  expect(session?.token_hash).toBeNull();
});
test('a repeated enrollment returns the same token', async () => {
  const ctx = await boot();

  ctx.simulated.drop('secret_injection');

  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Enroll',
    goal: 'Exchange one code for one token.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'enroll-group',
    bodyHash: 'enroll-group',
  });
  const prompt = promptMentioning(ctx.simulated, opened.session.id);
  const code = enrollmentCodeIn(prompt);

  const input = {
    sessionId: opened.session.id,
    code,
    idempotencyKey: 'enroll-once',
    bodyHash: sha256Hex(code),
  };
  const first = await enroll(ctx.deps, input);
  const second = await enroll(ctx.deps, input);
  const saved = await ctx.deps.store.session(defaultWorkspaceId, opened.session.id);

  const stored = await ctx.db.query<{ response: string }>(
    `SELECT response::text AS response FROM idempotency_keys WHERE route = 'session.enroll'`
  );
  const response = stored.rows[0]?.response ?? '';
  const copied = await ctx.db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM sessions WHERE token_hash = $1',
    [sha256Hex(response)]
  );

  expect(second.token).toBe(first.token);
  expect(saved?.token_hash).toBe(sha256Hex(first.token));
  expect(response.includes(first.token)).toBe(false);
  expect(copied.rows[0]?.count).toBe(0);
});
test('an ended start the platform does not know releases its place', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Never answered');

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId,
      role: 'implementer',
      instructions: 'Stop before the platform is asked.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: 'never-asked',
      bodyHash: 'never-asked',
      replacementOf: null,
      crashAt: 'after_reserve',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const starting = requirePresent(
    (await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id)).find(
      session => session.role === 'implementer'
    ),
    'the implementer should be stored'
  );

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: starting.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'The start never answered.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: starting.id,
  });
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(recovered.life).toBe('ended');
  expect(occupancy.live_sessions).toBe(1);
});

test('a task is locked before the caller session', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Lock order');
  const orders: string[][] = [];
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const order: string[] = [];

      orders.push(order);

      return work(watchLocks(tx, order));
    });

  await editChildTask(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    taskId,
    title: 'Lock order renamed',
    description: null,
  });
  await addTaskNote(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    taskId,
    note: 'A note while the task is locked first.',
    evidence: [],
  });

  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Start while the task lock comes first.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'lock-order',
    bodyHash: 'lock-order',
    replacementOf: null,
  });

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'End while the task lock comes first.',
  });

  const paired = orders.filter(order => order.includes('task') && order.includes('session'));

  expect(paired.length).toBeGreaterThan(0);

  for (const order of paired) {
    expect(order.indexOf('task')).toBeLessThan(order.indexOf('session'));
  }
});
test('the root is locked before a child', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(
    ctx.deps,
    ctx.opened.group.id,
    ctx.planner.id,
    'Lock the root first'
  );
  const orders: string[][] = [];
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const order: string[] = [];

      orders.push(order);

      return work(watchTaskIds(tx, order));
    });

  await editChildTask(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    taskId,
    title: 'Root lock comes first',
    description: null,
  });
  await addTaskNote(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    taskId,
    note: 'A note after the root lock.',
    evidence: [],
  });

  const paired = orders.filter(
    order => order.includes(ctx.opened.root.id) && order.includes(taskId)
  );

  expect(paired.length).toBeGreaterThan(0);

  for (const order of paired) {
    expect(order.indexOf(ctx.opened.root.id)).toBeLessThan(order.indexOf(taskId));
  }
});
test('a transaction that locks the group after a session is refused', async () => {
  const ctx = await withPlanner();

  const outOfOrder = ctx.deps.store.transact(async tx => {
    await tx.lockSession(defaultWorkspaceId, ctx.planner.id);
    await tx.lockGroup(defaultWorkspaceId, ctx.opened.group.id);
  });

  await expect(outOfOrder).rejects.toThrow(
    'Lock order violated: group locked after session. The order is workspace, group, root task, child task, session.'
  );
});

test('a transaction that locks a child before the root is refused', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Child first');

  const outOfOrder = ctx.deps.store.transact(async tx => {
    await tx.lockTask(defaultWorkspaceId, taskId);
    await tx.lockTask(defaultWorkspaceId, ctx.opened.root.id);
  });

  await expect(outOfOrder).rejects.toThrow(
    'Lock order violated: root task locked after child task.'
  );
});

test('a transaction may lock in the documented order and lock a held lock again', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'In order');

  const group = await ctx.deps.store.transact(async tx => {
    await tx.lockWorkspace(defaultWorkspaceId);
    await tx.lockGroup(defaultWorkspaceId, ctx.opened.group.id);
    await tx.lockTask(defaultWorkspaceId, ctx.opened.root.id);
    await tx.lockTask(defaultWorkspaceId, taskId);
    await tx.lockSession(defaultWorkspaceId, ctx.planner.id);

    return tx.lockGroup(defaultWorkspaceId, ctx.opened.group.id);
  });

  expect(requirePresent(group, 'the group should still be there').id).toBe(ctx.opened.group.id);
});

test('a transaction may lock two child tasks', async () => {
  const ctx = await withPlanner();
  const first = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'First child');
  const second = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Second child');

  const lockedSecond = await ctx.deps.store.transact(async tx => {
    await tx.lockTask(defaultWorkspaceId, ctx.opened.root.id);
    await tx.lockTask(defaultWorkspaceId, first);

    return tx.lockTask(defaultWorkspaceId, second);
  });

  expect(requirePresent(lockedSecond, 'the second child should still be there').id).toBe(second);
});

test('a transaction that locks the open children after a session is refused', async () => {
  const ctx = await withPlanner();

  await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'A child to lock');

  const outOfOrder = ctx.deps.store.transact(async tx => {
    await tx.lockSession(defaultWorkspaceId, ctx.planner.id);
    await tx.openChildren(defaultWorkspaceId, ctx.opened.group.id, ctx.opened.root.id);
  });

  await expect(outOfOrder).rejects.toThrow('Lock order violated: child task locked after session.');
});

test('a transaction that locks the groups with an outbox after a session is refused', async () => {
  const ctx = await withPlanner();

  const outOfOrder = ctx.deps.store.transact(async tx => {
    await tx.lockSession(defaultWorkspaceId, ctx.planner.id);
    await tx.lockGroupsWithOutbox(new Date(0).toISOString());
  });

  await expect(outOfOrder).rejects.toThrow('Lock order violated: group locked after session.');
});

test('a transaction that locks the root after the open children is refused', async () => {
  const ctx = await withPlanner();

  await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'A child before the root');

  const outOfOrder = ctx.deps.store.transact(async tx => {
    await tx.openChildren(defaultWorkspaceId, ctx.opened.group.id, ctx.opened.root.id);
    await tx.lockTask(defaultWorkspaceId, ctx.opened.root.id);
  });

  await expect(outOfOrder).rejects.toThrow(
    'Lock order violated: root task locked after child task.'
  );
});

test('failing the root with an open child locks the child before the planner session', async () => {
  const ctx = await withPlanner();
  const childId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Still open');
  const tasks = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);
  const root = requirePresent(
    tasks.find(task => task.parent_id === null),
    'the group should have a root task'
  );

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: root.id,
    expectedVersion: root.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  const afterwards = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);
  const child = requirePresent(
    afterwards.find(task => task.id === childId),
    'the child should still be there'
  );

  expect(child.state).toBe('failed');
});

test('a child transition locks the root before the child', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Close this child');
  const orders: string[][] = [];
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const order: string[] = [];

      orders.push(order);

      return work(watchTaskIds(tx, order));
    });

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    expectedVersion: 1,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  const paired = orders.filter(
    order => order.includes(ctx.opened.root.id) && order.includes(taskId)
  );

  expect(paired.length).toBeGreaterThan(0);

  for (const order of paired) {
    expect(order.indexOf(ctx.opened.root.id)).toBeLessThan(order.indexOf(taskId));
  }
});
test('only pull-request roles see the changeset', async () => {
  const ctx = await withPlanner();
  const planner = promptMentioning(ctx.simulated, ctx.planner.id);
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Write the change');

  await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'changeset-writer',
    bodyHash: 'changeset-writer',
    replacementOf: null,
  });

  const writer = requirePresent(
    ctx.simulated.prompts().at(-1),
    'the platform should have been prompted'
  );

  expect(planner).toContain('You are the planner');
  expect(planner).not.toContain('Changeset:');
  expect(writer).toContain('You are the implementer');
  expect(writer).toContain('Changeset:');
});
test('an enrollment prompt names the enroll flags and not the token', async () => {
  const ctx = await boot();

  ctx.simulated.drop('secret_injection');

  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Enroll',
    goal: 'Show the enroll command.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'prompt-group',
    bodyHash: 'prompt-group',
  });
  const prompt = promptMentioning(ctx.simulated, opened.session.id);
  const code = enrollmentCodeIn(prompt);

  expect(prompt).toContain(`hivemind enroll --session ${opened.session.id} --code ${code}`);
  expect(prompt.includes('ses_')).toBe(prompt.includes(opened.session.id));
});
test('empty planner instructions do not leave a group behind', async () => {
  const ctx = await boot();
  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Checkout',
    goal: 'Move tax calculation behind an interface.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge' as const,
    notes: [],
    idempotencyKey: 'blank-instructions',
    bodyHash: 'blank-instructions',
  };

  await expect(
    openGroup(ctx.deps, ctx.platforms, { ...input, instructions: '   ' })
  ).rejects.toMatchObject({ code: 'validation_failed' });

  const counted = await ctx.db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM groups'
  );

  expect(counted.rows[0]?.count).toBe(0);

  const opened = await openGroup(ctx.deps, ctx.platforms, {
    ...input,
    instructions: 'Plan the work.',
    bodyHash: 'real-instructions',
  });

  expect(opened.outcome).toBe('live');
});

test('a released planner cannot create a child from a stale live flag', async () => {
  const ctx = await withPlanner();

  await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Already planned');
  await releaseSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
  });

  await expect(
    createChildTask(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      actor: { sessionId: ctx.planner.id, live: true },
      title: 'After release',
      description: 'A child task with enough description to be stored.',
      verificationMode: null,
      dependsOn: [],
    })
  ).rejects.toMatchObject({ code: 'policy_denied' });
});
test('an implementer cannot move another task', async () => {
  const ctx = await withPlanner();
  const owned = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Owned work');
  const other = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Someone else');
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: owned,
    role: 'implementer',
    instructions: 'Write the owned change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'owned-writer',
    bodyHash: 'owned-writer',
    replacementOf: null,
  });

  await expect(
    reportTransition(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId: other,
      expectedVersion: 1,
      actor: {
        kind: 'session',
        role: 'implementer',
        sessionId: started.session.id,
        live: true,
      },
      to: 'implementing',
      note,
      evidence: [],
      nextVerificationMode: null,
    })
  ).rejects.toMatchObject({ code: 'policy_denied' });

  const tasks = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);

  expect(tasks.find(task => task.id === other)?.state).toBe('planned');
  expect(tasks.find(task => task.id === owned)?.state).toBe('planned');
});
test('a live planner can still fail a child task', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Abandoned work');
  const failed = await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    expectedVersion: 1,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  expect(failed.task.state).toBe('failed');
});
test('an ended implementer cannot move its task from a stale live flag', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Owned work');
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'ended-writer',
    bodyHash: 'ended-writer',
    replacementOf: null,
  });

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The writer is done.',
  });

  await expect(
    reportTransition(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId,
      expectedVersion: 1,
      actor: {
        kind: 'session',
        role: 'implementer',
        sessionId: started.session.id,
        live: true,
      },
      to: 'implementing',
      note,
      evidence: [],
      nextVerificationMode: null,
    })
  ).rejects.toMatchObject({ code: 'unauthenticated' });

  const task = (await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id)).find(
    item => item.id === taskId
  );

  expect(task?.state).toBe('planned');
});
test('a note locks the group before the root', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Note lock order');
  const orders: string[][] = [];
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const order: string[] = [];

      orders.push(order);

      return work(watchGroupAndTasks(tx, order));
    });

  await addTaskNote(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    taskId,
    note: 'Lock the group before the root.',
    evidence: [],
  });

  const order = orders.find(item => item.includes('group') && item.includes(ctx.opened.root.id));

  expect(order).toBeDefined();
  expect(order?.indexOf('group')).toBeLessThan(order?.indexOf(ctx.opened.root.id) ?? 0);
});
test('a replay of a refused start keeps the platform error class', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Quota');
  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer' as const,
    instructions: 'Write the change.',
    actor: { kind: 'session' as const, sessionId: ctx.planner.id },
    idempotencyKey: 'quota-start',
    bodyHash: 'quota-start',
    replacementOf: null,
  };

  ctx.simulated.queueError('start', 'quota');

  const first = await startSession(ctx.deps, ctx.platforms, input);
  const second = await startSession(ctx.deps, ctx.platforms, input);

  expect(first.outcome).toBe('refused');
  expect(first.errorClass).toBe('quota');
  expect(second.errorClass).toBe('quota');
});
test('two creates with one key save one child', async () => {
  const ctx = await withPlanner();

  await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Already planned');

  const input = {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    actor: { sessionId: ctx.planner.id, live: true },
    title: 'One child',
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
    idempotency: {
      key: 'same-child',
      bodyHash: 'same-child',
      callerKind: 'session',
      callerId: ctx.planner.id,
      route: 'POST /v1/tasks',
    },
  };
  const results = await Promise.allSettled([
    createChildTask(ctx.deps, input),
    createChildTask(ctx.deps, input),
  ]);
  const ids = results.flatMap(result =>
    result.status === 'fulfilled' ? [result.value.task.id] : []
  );
  const children = (await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id)).filter(
    task => task.parent_id !== null
  );

  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  expect(ids[0]).toBe(ids[1]);
  expect(children).toHaveLength(2);
});

test('a second challenger is not a replacement', async () => {
  const ctx = await withPlanner();

  await setCaps(ctx.db, ctx.opened.group.id, { ...selfHostedGroupCaps, respawns_per_task_role: 0 });

  const first = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    role: 'challenger',
    instructions: 'Question the plan.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'challenger-1',
    bodyHash: 'challenger-1',
    replacementOf: null,
  });
  const second = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    role: 'challenger',
    instructions: 'Question the plan again.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'challenger-2',
    bodyHash: 'challenger-2',
    replacementOf: null,
  });
  const prompts = ctx.simulated.prompts();

  expect(first.outcome).toBe('live');
  expect(second.outcome).toBe('live');
  expect(second.session.attempt).toBe(1);
  expect(prompts.at(-1)?.includes('You are a replacement.')).toBe(false);
});
test('a refused implementer does not block a solo goal', async () => {
  const ctx = await withPlanner();
  const analyzing = await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: ctx.opened.root.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'analyzing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  await ctx.db.query(
    `INSERT INTO sessions (
       id, workspace_id, group_id, task_id, role, attempt, title, life, start_attempt_id,
       final_usage_pending, created_at
     ) VALUES (
       'ses_refused', $1, $2, $3, 'implementer', 1, 'Refused implementer', 'start_failed',
       'start-refused', false, '2026-11-16T00:00:00.000Z'
     )`,
    [defaultWorkspaceId, ctx.opened.group.id, ctx.opened.root.id]
  );

  const done = await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: analyzing.task.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'done',
    note,
    evidence: [{ label: 'pull request', kind: 'address', value: 'https://example.com/pr/1' }],
    nextVerificationMode: null,
  });

  expect(done.task.state).toBe('done');
});
test('a retry resumes an end that stopped after the intent', async () => {
  const ctx = await withPlanner();

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'Stop after the intent is saved.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const resumed = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop after the intent is saved.',
  });

  expect(resumed.life).toBe('ended');
  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBeGreaterThan(0);
});
test('a planner cannot edit the root task through the child edit', async () => {
  const ctx = await withPlanner();

  await expect(
    editChildTask(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      taskId: ctx.opened.root.id,
      title: 'A different goal',
      description: null,
    })
  ).rejects.toMatchObject({ code: 'policy_denied' });

  const tasks = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);
  const root = tasks.find(task => task.id === ctx.opened.root.id);

  expect(root?.title).toBe(ctx.opened.root.title);
});
test('a refused start does not spend a replacement', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Refused writer');

  await setCaps(ctx.db, ctx.opened.group.id, { ...selfHostedGroupCaps, respawns_per_task_role: 0 });
  ctx.simulated.queueError('start', 'auth');

  const refused = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'This start is refused.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'refused-writer',
    bodyHash: 'refused-writer',
    replacementOf: null,
  });
  const again = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'This start is a first attempt.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'first-writer',
    bodyHash: 'first-writer',
    replacementOf: null,
  });
  const prompt = requirePresent(
    ctx.simulated.prompts().at(-1),
    'the platform should have been prompted'
  );

  expect(refused.outcome).toBe('refused');
  expect(refused.session.attempt).toBe(1);
  expect(again.outcome).toBe('live');
  expect(again.session.attempt).toBe(1);
  expect(prompt).not.toContain('You are a replacement.');
});
test('a planner start that hits a cap closes the group', async () => {
  const ctx = await boot();

  await ctx.db.query(
    `UPDATE workspaces SET limits = jsonb_set(limits, '{live_sessions}', '0') WHERE id = $1`,
    [defaultWorkspaceId]
  );

  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Orphan',
    goal: 'Do not leave a group without a planner.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge' as const,
    notes: [],
    instructions: 'Plan the work.',
  };
  const first = openGroup(ctx.deps, ctx.platforms, {
    ...input,
    idempotencyKey: 'orphan-1',
    bodyHash: 'orphan-1',
  });

  await expect(first).rejects.toMatchObject({ code: 'cap_reached' });

  let named = '';
  let message = '';

  try {
    await first;
  } catch (error) {
    if (error instanceof HivemindError) {
      named = String(error.details.group_id);
      message = error.message;
    }
  }

  await expect(
    openGroup(ctx.deps, ctx.platforms, {
      ...input,
      idempotencyKey: 'orphan-2',
      bodyHash: 'orphan-2',
    })
  ).rejects.toMatchObject({ code: 'cap_reached' });

  const groups = await ctx.db.query<{ id: string; status: string }>(
    'SELECT id, status FROM groups ORDER BY created_at'
  );
  const firstGroup = groups.rows[0]?.id ?? '';

  expect(groups.rows).toHaveLength(2);
  expect(groups.rows.every(group => group.status === 'closed')).toBe(true);
  expect(named).toBe(firstGroup);
  expect(message).toContain(firstGroup);
});

test('a released member cannot resume on a closed task', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Finished work');
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'closed-task-writer',
    bodyHash: 'closed-task-writer',
    replacementOf: null,
  });

  await releaseSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: started.session.id,
  });

  const tasks = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);
  const child = tasks.find(task => task.id === taskId);

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    expectedVersion: child?.version ?? 1,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note: 'The work is abandoned.',
    evidence: [],
    nextVerificationMode: null,
  });

  await expect(
    resumeSession(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sessionId: started.session.id,
    })
  ).rejects.toMatchObject({ code: 'conflict' });

  const session = await ctx.deps.store.session(defaultWorkspaceId, started.session.id);
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(session?.life).toBe('released');
  expect(occupancy.live_sessions).toBe(1);
});

test('a failed planner start closes the group on retry', async () => {
  const ctx = await boot();

  ctx.simulated.queueError('start', 'unavailable');

  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Pending',
    goal: 'Close the group when the planner never starts.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge' as const,
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'pending-planner',
    bodyHash: 'pending-planner',
  };
  const opened = await openGroup(ctx.deps, ctx.platforms, input);

  expect(opened.outcome).toBe('start_pending');

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: opened.session.id,
  });

  expect(recovered.life).toBe('start_failed');

  const again = await openGroup(ctx.deps, ctx.platforms, input);
  const group = await ctx.deps.store.group(defaultWorkspaceId, opened.group.id);

  expect(again.outcome).toBe('refused');
  expect(group?.status).toBe('closed');
});

test('a retry of a failed group open returns the first error', async () => {
  const ctx = await boot();

  await ctx.db.query(
    `UPDATE workspaces SET limits = jsonb_set(limits, '{live_sessions}', '0') WHERE id = $1`,
    [defaultWorkspaceId]
  );

  const input = {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Retry',
    goal: 'Return the first failure for the same key.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge' as const,
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'orphan-same',
    bodyHash: 'orphan-same',
  };
  let first: HivemindError | undefined;

  try {
    await openGroup(ctx.deps, ctx.platforms, input);
  } catch (error) {
    if (error instanceof HivemindError) first = error;
  }

  await expect(openGroup(ctx.deps, ctx.platforms, input)).rejects.toMatchObject({
    code: 'cap_reached',
    message: first?.message,
  });

  const groups = await ctx.db.query<{ id: string; status: string }>(
    'SELECT id, status FROM groups ORDER BY created_at'
  );
  const closed = groups.rows[0];

  expect(first?.code).toBe('cap_reached');
  expect(groups.rows).toHaveLength(1);
  expect(closed?.status).toBe('closed');
  expect(String(first?.details.group_id)).toBe(closed?.id ?? '');
});

test('a released session cannot resume in a closed group', async () => {
  const ctx = await withPlanner();

  await releaseSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
  });
  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: ctx.opened.root.version,
    actor: { kind: 'person', personId: ctx.admin.id },
    to: 'failed',
    note: 'The goal is abandoned.',
    evidence: [],
    nextVerificationMode: null,
  });

  await expect(
    resumeSession(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
    })
  ).rejects.toMatchObject({ code: 'group_closed' });

  const session = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(session?.life).toBe('released');
  expect(occupancy.live_sessions).toBe(0);
});

test('the same key replaces two different sessions', async () => {
  const ctx = await withPlanner();
  const first = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    role: 'challenger',
    instructions: 'Question the plan.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'challenger-a',
    bodyHash: 'same-instructions',
    replacementOf: null,
  });
  const second = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    role: 'challenger',
    instructions: 'Question the plan.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'challenger-b',
    bodyHash: 'same-instructions',
    replacementOf: null,
  });

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: first.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The first challenger is done.',
  });
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: second.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The second challenger is done.',
  });

  const replacedFirst = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    role: 'challenger',
    instructions: 'Question the plan.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'same-replace-key',
    bodyHash: 'same-instructions',
    replacementOf: first.session.id,
  });
  const replacedSecond = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    role: 'challenger',
    instructions: 'Question the plan.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'same-replace-key',
    bodyHash: 'same-instructions',
    replacementOf: second.session.id,
  });

  expect(replacedFirst.outcome).toBe('live');
  expect(replacedSecond.outcome).toBe('live');
  expect(replacedSecond.session.id).not.toBe(replacedFirst.session.id);
});

test('an edit uses the same character limit as creation', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Edit the title');
  const title = '测'.repeat(50);
  const edited = await editChildTask(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    taskId,
    title,
    description: null,
  });

  expect(title.length).toBe(50);
  expect(Buffer.byteLength(title)).toBeGreaterThan(120);
  expect(edited.title).toBe(title);

  await expect(
    editChildTask(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      taskId,
      title: 'a'.repeat(121),
      description: null,
    })
  ).rejects.toMatchObject({
    code: 'validation_failed',
    message: 'A task title is 1 to 120 characters.',
  });
});

function platformRefOf(
  session: { platform_session_ref: string | null } | null | undefined
): string {
  return requirePresent(
    session?.platform_session_ref,
    'the session should have a platform reference'
  );
}

function holdFind(ctx: Service): {
  entered: Promise<void>;
  release: () => void;
  ended: string[];
} {
  let release = (): void => {};
  let markEntered = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const entered = new Promise<void>(resolve => {
    markEntered = resolve;
  });
  const ended: string[] = [];
  const real = ctx.simulated.adapter;
  const adapter: PlatformAdapter = {
    ...real,
    async findByKey() {
      markEntered();
      await gate;

      return { outcome: 'absent' };
    },
    async end(connection, ref) {
      ended.push(ref);

      return real.end(connection, ref);
    },
  };

  replaceAdapter(ctx, adapter);

  return { entered, release, ended };
}

test('a prompt does not name a command this phase does not have', async () => {
  const ctx = await withPlanner();
  const prompt = requirePresent(
    ctx.simulated.prompts()[0],
    'the platform should have been prompted'
  );

  expect(prompt).not.toContain('escalate command');
  expect(prompt).not.toContain(
    'Send every message to another member through the command-line tool'
  );
});

test('a failed cleanup of a late start stays retryable', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late cleanup');
  const held = holdPlatform(ctx, { failEnds: 1 });
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'late-cleanup',
    bodyHash: 'late-cleanup',
    replacementOf: null,
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  const compensated = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  expect(compensated.life).toBe('start_failed');
  held.release();
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });

  const unfinished = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const stillRunning = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(unfinished)
  );

  expect(unfinished?.life).toBe('start_failed');
  expect(unfinished?.platform_session_ref).not.toBeNull();
  expect(unfinished?.final_usage_pending).toBe(true);
  expect(stillRunning.status).toBe('working');

  ctx.simulated.controls.setReportedUsage(4);

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(recovered)
  );

  expect(recovered.life).toBe('start_failed');
  expect(recovered.final_usage_pending).toBe(false);
  expect(group?.spend).toBe('4');
  expect(occupancy.live_sessions).toBe(1);
  expect(status.status).toBe('stopped');
});

test('ending a refused start leaves the row unchanged', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Refused end');

  ctx.simulated.queueError('start', 'quota');

  const refused = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'The platform refuses this start.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'refused-end',
    bodyHash: 'refused-end',
    replacementOf: null,
  });
  const endsBefore = ctx.simulated.calls().filter(call => call === 'end').length;
  const ended = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: refused.session.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The refused member needs no platform stop.',
  });

  expect(refused.outcome).toBe('refused');
  expect(ended.life).toBe('start_failed');
  expect(ended.end_requested_at).toBeNull();
  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBe(endsBefore);
});

test('ending a compensated start retries the stop once', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Retry the stop');
  const held = holdPlatform(ctx, { failEnds: 2 });
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'retry-stop',
    bodyHash: 'retry-stop',
    replacementOf: null,
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  const compensated = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  expect(compensated.life).toBe('start_failed');
  held.release();
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: reserved.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'The late session is still running.',
    })
  ).rejects.toMatchObject({ code: 'unavailable' });

  const unfinished = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const stillRunning = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(unfinished)
  );

  expect(unfinished?.life).toBe('start_failed');
  expect(unfinished?.final_usage_pending).toBe(true);
  expect(unfinished?.end_requested_at).toBeNull();
  expect(stillRunning.status).toBe('working');

  ctx.simulated.controls.setReportedUsage(4);

  const stopped = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop the session that is still running.',
  });
  const endsAfterStop = ctx.simulated.calls().filter(call => call === 'end').length;
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    platformRefOf(stopped)
  );
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(stopped.life).toBe('start_failed');
  expect(stopped.final_usage_pending).toBe(false);
  expect(stopped.end_requested_at).toBeNull();
  expect(status.status).toBe('stopped');
  expect(group?.spend).toBe('4');
  expect(occupancy.live_sessions).toBe(1);

  const again = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The stop already finished.',
  });
  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  expect(again.life).toBe('start_failed');
  expect(again.final_usage_pending).toBe(false);
  expect(recovered.final_usage_pending).toBe(false);
  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBe(endsAfterStop);
});

test('a replay of a release stays released after the session resumes', async () => {
  const ctx = await withPlanner();
  const release = {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    idempotency: { key: 'release-snapshot', bodyHash: 'release-snapshot' },
  };
  const released = await releaseSession(ctx.deps, release);

  await resumeSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    idempotency: { key: 'resume-after-release', bodyHash: 'resume-after-release' },
  });

  const replay = await releaseSession(ctx.deps, release);
  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(released.life).toBe('released');
  expect(replay.life).toBe('released');
  expect(stored?.life).toBe('live');
});

test('a replay of a transition keeps the state that report applied', async () => {
  const ctx = await withPlanner();
  const idempotency = {
    key: 'analyze-once',
    bodyHash: 'analyze-once',
    callerKind: 'session',
    callerId: ctx.planner.id,
    route: 'POST /v1/tasks/root/transitions',
  };
  const first = await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: ctx.opened.root.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'analyzing',
    note,
    evidence: [],
    nextVerificationMode: null,
    idempotency,
  });

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: first.task.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  const replay = await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: ctx.opened.root.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'analyzing',
    note,
    evidence: [],
    nextVerificationMode: null,
    idempotency,
  });

  expect(first.task.state).toBe('analyzing');
  expect(replay.task.state).toBe(first.task.state);
  expect(replay.task.version).toBe(first.task.version);
  expect(replay.group.status).toBe(first.group.status);
});

test('a replay of a created task keeps the task that create applied', async () => {
  const ctx = await withPlanner();

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: ctx.opened.root.id,
    expectedVersion: ctx.opened.root.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'analyzing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  const idempotency = {
    key: 'child-once',
    bodyHash: 'child-once',
    callerKind: 'session',
    callerId: ctx.planner.id,
    route: 'POST /v1/tasks',
  };
  const created = await createChildTask(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    actor: { sessionId: ctx.planner.id, live: true },
    title: 'Keep this title',
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
    idempotency,
  });

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: created.task.id,
    expectedVersion: created.task.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  const replay = await createChildTask(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    actor: { sessionId: ctx.planner.id, live: true },
    title: 'Keep this title',
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
    idempotency,
  });

  expect(replay.task.state).toBe('planned');
  expect(replay.task.version).toBe(created.task.version);
  expect(replay.task.id).toBe(created.task.id);
});

test('a platform session that appears after compensation is stopped', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late create');
  const held = holdPlatform(ctx);
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'late-create',
    bodyHash: 'late-create',
    replacementOf: null,
    crashAt: 'after_platform_accept',
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  const compensated = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  expect(compensated.life).toBe('start_failed');
  held.release();
  await expect(pending).rejects.toBeInstanceOf(StoppedProcess);

  const running = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    `plat_${reserved.id}`
  );

  expect(running.status).toBe('working');

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    recovered.platform_session_ref ?? `plat_${reserved.id}`
  );

  expect(recovered.life).toBe('start_failed');
  expect(recovered.final_usage_pending).toBe(false);
  expect(status.status).toBe('stopped');
});

test('ending a compensated start looks for a platform session that appeared later', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Late end');
  const held = holdPlatform(ctx);
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'late-end',
    bodyHash: 'late-end',
    replacementOf: null,
    crashAt: 'after_platform_accept',
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });
  held.release();
  await expect(pending).rejects.toBeInstanceOf(StoppedProcess);

  const ended = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'Stop the session that appeared after compensation.',
  });
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    ended.platform_session_ref ?? `plat_${reserved.id}`
  );

  expect(ended.life).toBe('start_failed');
  expect(ended.final_usage_pending).toBe(false);
  expect(status.status).toBe('stopped');
});

test('an end error during start is not a refused start', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'End refused');
  const held = holdPlatform(ctx);
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'end-quota',
    bodyHash: 'end-quota',
    replacementOf: null,
  });
  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: reserved.id,
      actor: { kind: 'session', sessionId: ctx.planner.id },
      reason: 'Record the end before the platform answers.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);
  ctx.simulated.queueError('end', 'quota');
  held.release();

  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });

  const session = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    session?.platform_session_ref ?? `plat_${reserved.id}`
  );

  expect(session?.life).not.toBe('start_failed');
  expect(session?.end_requested_at).not.toBeNull();
  expect(status.status).toBe('working');
});

test('recovery stops a reference attached to a compensated start', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, 'Attach then stop');
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'attach-stop',
    bodyHash: 'attach-stop',
    replacementOf: null,
    crashAt: 'after_platform_accept',
  });

  await expect(pending).rejects.toBeInstanceOf(StoppedProcess);

  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const real = ctx.simulated.adapter;

  replaceAdapter(ctx, {
    ...real,
    async findByKey(connection, key, startedAt) {
      await gate;

      return real.findByKey(connection, key, startedAt);
    },
  });

  const recovery = recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  await ctx.db.query(`UPDATE sessions SET life = 'start_failed' WHERE id = $1`, [reserved.id]);
  release();

  const recovered = await recovery;
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    recovered.platform_session_ref ?? `plat_${reserved.id}`
  );

  expect(recovered.life).toBe('start_failed');
  expect(recovered.final_usage_pending).toBe(false);
  expect(status.status).toBe('stopped');
});

test('a failed stop of a reference attached during recovery stays retryable', async () => {
  const ctx = await withPlanner();
  const taskId = await childTask(
    ctx.deps,
    ctx.opened.group.id,
    ctx.planner.id,
    'Attach then retry'
  );
  const pending = startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Write the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'attach-retry',
    bodyHash: 'attach-retry',
    replacementOf: null,
    crashAt: 'after_platform_accept',
  });

  await expect(pending).rejects.toBeInstanceOf(StoppedProcess);

  const reserved = await waitForRole(ctx.deps, ctx.opened.group.id, 'implementer');
  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const real = ctx.simulated.adapter;

  replaceAdapter(ctx, {
    ...real,
    async findByKey(connection, key, startedAt) {
      await gate;

      return real.findByKey(connection, key, startedAt);
    },
  });
  ctx.simulated.queueError('end', 'unavailable');

  const recovery = recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });

  await ctx.db.query(`UPDATE sessions SET life = 'start_failed' WHERE id = $1`, [reserved.id]);
  release();
  await expect(recovery).rejects.toMatchObject({ code: 'unavailable' });

  const stuck = await ctx.deps.store.session(defaultWorkspaceId, reserved.id);

  expect(stuck?.life).toBe('start_failed');
  expect(stuck?.final_usage_pending).toBe(true);

  const recovered = await recoverStart(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
  });
  const status = await ctx.simulated.adapter.readStatus(
    ctx.simulated.connection(),
    recovered.platform_session_ref ?? `plat_${reserved.id}`
  );

  expect(recovered.final_usage_pending).toBe(false);
  expect(status.status).toBe('stopped');
});

test('an enrollment code expires from the moment it is created', async () => {
  const ctx = await boot();

  ctx.simulated.drop('secret_injection');

  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let captured = '';
  const real = ctx.simulated.adapter;

  replaceAdapter(ctx, {
    ...real,
    async start(connection, input) {
      captured = input.prompt;
      await gate;

      return real.start(connection, input);
    },
  });

  const opening = openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Expiry',
    goal: 'A code must expire while the start is still running.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'expiry-group',
    bodyHash: 'expiry-group',
  });

  await waitUntil(() => (captured === '' ? null : captured), 'the start to receive its prompt');

  const matched = /enroll --session (\S+) --code (enr_[A-Za-z0-9_-]+)/.exec(captured);
  const sessionId = matched === null ? undefined : requireSessionId(matched[1] ?? '');
  const code = matched?.[2];

  if (sessionId === undefined || code === undefined) {
    throw new Error('the prompt should carry an enrollment code');
  }

  const created = await ctx.deps.store.transact(tx => tx.openEnrollmentCode(sessionId));

  expect(created?.expires_at).not.toBeNull();
  expect(Date.parse(created?.expires_at ?? '') - Date.parse(created?.created_at ?? '')).toBe(
    15 * 60 * 1000
  );

  ctx.deps.clock.advance(15 * 60 * 1000);

  await expect(
    enroll(ctx.deps, {
      sessionId,
      code,
      idempotencyKey: 'expiry-starting',
      bodyHash: 'expiry-starting',
    })
  ).rejects.toMatchObject({ code: 'unauthenticated' });

  const starting = await ctx.deps.store.session(defaultWorkspaceId, sessionId);

  expect(starting?.life).toBe('starting');

  release();

  const opened = await opening;
  const live = await ctx.deps.store.transact(tx => tx.openEnrollmentCode(sessionId));

  expect(opened.session.life).toBe('live');
  expect(live?.expires_at).toBe(created?.expires_at);

  const released = await releaseSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId,
  });
  const afterRelease = await ctx.deps.store.transact(tx => tx.openEnrollmentCode(sessionId));

  expect(released.life).toBe('released');
  expect(afterRelease?.expires_at).toBe(created?.expires_at);

  await expect(
    enroll(ctx.deps, {
      sessionId,
      code,
      idempotencyKey: 'expiry-released',
      bodyHash: 'expiry-released',
    })
  ).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('an ended session and a refused start do not keep an enrollment code', async () => {
  const ctx = await boot();

  ctx.simulated.drop('secret_injection');

  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Ended code',
    goal: 'Ending a session voids its enrollment code.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'ended-code-group',
    bodyHash: 'ended-code-group',
  });
  const prompt = promptMentioning(ctx.simulated, opened.session.id);
  const code = enrollmentCodeIn(prompt);

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: opened.session.id,
    actor: { kind: 'person', personId: ctx.admin.id },
    reason: 'The planner is done before it enrolls.',
  });

  const endedCode = await ctx.deps.store.transact(tx => tx.openEnrollmentCode(opened.session.id));

  expect(endedCode).toBeNull();

  await expect(
    enroll(ctx.deps, {
      sessionId: opened.session.id,
      code,
      idempotencyKey: 'ended-code',
      bodyHash: 'ended-code',
    })
  ).rejects.toMatchObject({ code: 'unauthenticated' });

  ctx.simulated.queueError('start', 'quota');

  const refused = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    name: 'Refused code',
    goal: 'A refused start voids its enrollment code.',
    budget: '100',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the work.',
    idempotencyKey: 'refused-code-group',
    bodyHash: 'refused-code-group',
  });
  const refusedCode = await ctx.deps.store.transact(tx =>
    tx.openEnrollmentCode(refused.session.id)
  );

  expect(refused.session.life).toBe('start_failed');
  expect(refusedCode).toBeNull();
});

function holdPlatform(ctx: Service, options?: { failEnds: number }): { release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let hide = true;
  let failEnds = options?.failEnds ?? 0;
  const real = ctx.simulated.adapter;
  const adapter: PlatformAdapter = {
    ...real,
    async start(connection, input) {
      await gate;
      hide = false;

      return real.start(connection, input);
    },
    async findByKey(connection, key, startedAt) {
      if (hide) return { outcome: 'absent' };

      return real.findByKey(connection, key, startedAt);
    },
    async end(connection, ref) {
      if (failEnds > 0) {
        failEnds -= 1;

        throw new PlatformError('unavailable', 'The platform did not answer.');
      }

      return real.end(connection, ref);
    },
  };

  replaceAdapter(ctx, adapter);

  return { release };
}

async function endedBeforePlatformAccept(
  ctx: Awaited<ReturnType<typeof withPlanner>>,
  title: string
): Promise<{ id: SessionId; title: string }> {
  const taskId = await childTask(ctx.deps, ctx.opened.group.id, ctx.planner.id, title);

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId,
      role: 'implementer',
      instructions: 'The platform has not accepted yet.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: title,
      bodyHash: title,
      replacementOf: null,
      crashAt: 'after_reserve',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);

  const sessions = await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id);
  const reserved = requirePresent(
    sessions.find(session => session.role === 'implementer' && session.life === 'starting'),
    'the reserved session should exist'
  );

  const ended = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: reserved.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The platform had not accepted.',
  });

  expect(ended.life).toBe('ended');
  expect(ended.platform_session_ref).toBeNull();
  expect(ended.final_usage_pending).toBe(false);

  return reserved;
}

async function acceptAfterEnd(
  ctx: Awaited<ReturnType<typeof withPlanner>>,
  reserved: { id: SessionId; title: string }
): Promise<void> {
  const group = requirePresent(
    await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id),
    'the group should exist'
  );

  await ctx.simulated.adapter.start(ctx.simulated.connection(), {
    prompt: 'The platform accepted after the row ended.',
    title: reserved.title,
    idempotencyKey: reserved.id,
    settings: group.session_settings,
    secret: null,
    onBehalfOf: null,
    usageCeiling: null,
    tags: {
      workspaceId: defaultWorkspaceId,
      groupId: group.id,
      sessionId: reserved.id,
      role: 'implementer',
    },
  });
}

function waitForRole(
  deps: ServiceDeps,
  groupId: GroupId,
  role: 'implementer'
): Promise<{ id: SessionId }> {
  return waitUntil(async () => {
    const sessions = await deps.store.sessions(defaultWorkspaceId, groupId);

    return sessions.find(session => session.role === role && session.life === 'starting');
  }, `the ${role} start to reserve a session`);
}
