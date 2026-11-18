import { expect, spyOn, test } from 'bun:test';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { runReaper } from '@/core/reaper.ts';
import { writeReaperWatch } from '@/core/reaper-actions.ts';
import { reportTransition } from '@/core/report-records.ts';
import { noteActivity } from '@/core/session-activity.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { startSession } from '@/core/session-start.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { createChildTask } from '@/core/task-records.ts';
import { defaultWorkspaceId, type GroupId, type SessionId } from '@/domain/ids.ts';
import { PlatformError } from '@/domain/platform.ts';
import {
  closedTaskGraceMs,
  emptyWatch,
  reaperIntervalMs,
  searchWindowMs,
  startingResolveMs,
  suspendIdleMs,
} from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Store } from '@/ports/storage.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService } from '@/testing/boot.ts';
import type { TestDeps } from '@/testing/deps.ts';
import { checkoutGroup, note } from '@/testing/fixtures.ts';
import { simulatedAdapterName } from '@/testing/platforms.ts';
import { runAfterTest } from '@/testing/teardown.ts';

async function team() {
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
  await deps.store.saveConnection({
    workspaceId: defaultWorkspaceId,
    id: service.connectionId,
    adapter: simulatedAdapterName,
    createdAt: formatTime(deps.clock.now()),
  });

  const opened = await openGroup(deps, service.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: admin.id,
    ...checkoutGroup,
    connectionId: service.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'supervision-group',
    bodyHash: 'supervision-group',
  });

  expect(opened.outcome).toBe('live');
  if (opened.outcome !== 'live') throw new Error('planner did not start');

  await noteActivity(deps, defaultWorkspaceId, opened.session.id, false);

  return { ...service, admin, opened, planner: opened.session };
}

test('the reaper ends sessions of a task closed for 60 minutes', async () => {
  const ctx = await team();
  const implementer = await startImplementerOnFailedTask(ctx);

  advance(ctx.deps, closedTaskGraceMs - 1000);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const early = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);

  expect(early?.life).toBe('live');

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const ended = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);

  expect(ended?.life).toBe('ended');
  expect(ended?.end_reason).toBe('task_closed');
});

test('a session the reaper cannot handle is logged with its cause and does not stop the others', async () => {
  const ctx = await team();
  const logged = spyOn(console, 'error').mockImplementation(() => {});

  runAfterTest(() => logged.mockRestore());

  const implementer = await startImplementerOnFailedTask(ctx);

  ctx.simulated.queueError('suspend', 'unavailable');
  advance(ctx.deps, suspendIdleMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const ended = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);
  const [message, cause] = requirePresent(logged.mock.calls[0], 'the failure should be logged');

  expect(ended?.life).toBe('ended');
  expect(logged).toHaveBeenCalledTimes(1);
  expect(message).toContain('on the next run');
  expect(cause).toBeInstanceOf(PlatformError);
});

test('a platform stop that fails is counted, kept as an open intent, and retried on the next run', async () => {
  const ctx = await team();
  const warned = spyOn(console, 'warn').mockImplementation(() => {});

  runAfterTest(() => warned.mockRestore());

  const implementer = await startImplementerOnFailedTask(ctx);

  ctx.simulated.queueError('end', 'unavailable');
  advance(ctx.deps, closedTaskGraceMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const watch = await savedWatch(ctx.deps, implementer.id);
  const stillLive = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);

  expect(watch?.endAttemptRuns).toBe(1);
  expect(stillLive?.life).toBe('live');
  expect(warned).toHaveBeenCalledTimes(1);
  expect(warned.mock.calls[0]?.[0]).toContain('on its next run');
  expect(warned.mock.calls[0]?.[1]).toMatchObject({ code: 'unavailable' });
  expect(await ctx.deps.store.transact(tx => tx.openIntents('reaper'))).toHaveLength(1);

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const retried = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);
  const open = await ctx.deps.store.transact(tx => tx.openIntents('reaper'));

  expect(retried?.life).toBe('ended');
  expect(open).toHaveLength(0);
});

test('a starting record older than 10 minutes is resolved', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  ctx.simulated.loseNextStartResponse();

  const pending = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'The start reply is lost.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'pending-start',
    bodyHash: 'pending-start',
    replacementOf: null,
  });

  expect(pending.outcome).toBe('start_pending');

  const findsBefore = ctx.simulated.calls().filter(call => call === 'findByKey').length;

  advance(ctx.deps, startingResolveMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const resolved = await ctx.deps.store.session(defaultWorkspaceId, pending.session.id);
  const finds = ctx.simulated.calls().filter(call => call === 'findByKey').length - findsBefore;

  expect(resolved?.life).toBe('live');
  expect(finds).toBe(1);
});

test('an unfinished end resumes on the next reaper run', async () => {
  const ctx = await team();

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      actor: { kind: 'service' },
      reason: 'Stop halfway.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const ended = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(ended?.life).toBe('ended');
});

test('a session idle for a day whose end stopped halfway is ended, not suspended', async () => {
  const ctx = await team();

  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      actor: { kind: 'service' },
      reason: 'Stop halfway.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);
  advance(ctx.deps, suspendIdleMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const ended = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(ended?.life).toBe('ended');
  expect(ctx.simulated.calls()).not.toContain('suspend');
});

test('cap repair locks the rows and restores the live count', async () => {
  const ctx = await team();

  await ctx.db.query('UPDATE groups SET live_sessions = 99 WHERE id = $1', [ctx.opened.group.id]);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, ctx.opened.group.id);

  expect(occupancy.live_sessions).toBe(1);
});

test('a pending stop of a failed start is finished, and a finished one is left', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  ctx.simulated.queueError('start', 'invalid');

  const refused = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'The platform refuses this start.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'orphan-stop',
    bodyHash: 'orphan-stop',
    replacementOf: null,
  });
  const ref = `plat_${refused.session.id}`;

  ctx.simulated.plantSession(refused.session.id);
  await ctx.db.query(
    `UPDATE sessions
     SET platform_session_ref = $2, final_usage_pending = true, platform_stop_pending = true
     WHERE id = $1`,
    [refused.session.id, ref]
  );
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stopped = await ctx.deps.store.session(defaultWorkspaceId, refused.session.id);

  expect(stopped?.final_usage_pending).toBe(false);
  expect(stopped?.platform_stop_pending).toBe(false);

  const ends = ctx.simulated.calls().filter(call => call === 'end').length;

  expect(ends).toBe(1);

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBe(ends);
});

test('a reaper epoch that a later run replaced does not save the watch', async () => {
  const ctx = await team();
  const first = await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  advance(ctx.deps, reaperIntervalMs);

  const second = await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });
  const staleEpoch = requirePresent(first.epoch, 'the first run should take the lease');
  const currentEpoch = requirePresent(second.epoch, 'the second run should take the lease');
  const watch = emptyWatch(ctx.planner.id, defaultWorkspaceId);

  watch.endAttemptRuns = 4;
  watch.lastFind = 'absent';
  watch.inconclusiveRuns = 2;
  watch.suspendedProgressAt = formatTime(ctx.deps.clock.now());

  await expect(writeReaperWatch(ctx.deps, staleEpoch, watch)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await savedWatch(ctx.deps, ctx.planner.id)).toBeUndefined();

  await writeReaperWatch(ctx.deps, currentEpoch, watch);

  expect(await savedWatch(ctx.deps, ctx.planner.id)).toMatchObject({
    endAttemptRuns: 4,
    lastFind: 'absent',
    inconclusiveRuns: 2,
  });
});

test('the reaper leaves a planner whose root task is still implementing', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'Keep going.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'still-open',
    bodyHash: 'still-open',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');

  await ctx.db.query(
    `UPDATE tasks SET state = 'implementing', state_entered_at = created_at
     WHERE group_id = $1 AND parent_id IS NULL`,
    [ctx.opened.group.id]
  );
  advance(ctx.deps, 61 * 60 * 1000);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const planner = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(planner?.life).toBe('live');
  expect(planner?.end_reason).toBeNull();
});

test('a session with no report for a day is suspended once, and stays live', async () => {
  const ctx = await team();

  advance(ctx.deps, suspendIdleMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const suspends = () => ctx.simulated.calls().filter(call => call === 'suspend').length;

  expect(suspends()).toBe(1);

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const planner = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const watch = requirePresent(
    await savedWatch(ctx.deps, ctx.planner.id),
    'the suspension should be remembered'
  );

  expect(suspends()).toBe(1);
  expect(planner?.life).toBe('live');
  expect(watch.suspendedAt).not.toBeNull();
});

test('a session that reports after the fleet was read is not suspended', async () => {
  const ctx = await team();
  const store: Store = {
    ...ctx.deps.store,
    transact: async work => {
      const result = await ctx.deps.store.transact(work);

      if (typeof result === 'object' && result !== null && 'watches' in result) {
        await noteActivity(ctx.deps, defaultWorkspaceId, ctx.planner.id, true);
      }

      return result;
    },
  };

  advance(ctx.deps, suspendIdleMs);
  await runReaper({ ...ctx.deps, store }, ctx.platforms, { workerId: 'worker' });

  const planner = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(ctx.simulated.calls()).not.toContain('suspend');
  expect(planner?.life).toBe('live');
});

test('resuming an end keeps what the reaper remembered about the session', async () => {
  const ctx = await team();

  advance(ctx.deps, suspendIdleMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });
  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      actor: { kind: 'service' },
      reason: 'Stop halfway.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);
  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const ended = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const watch = requirePresent(
    await savedWatch(ctx.deps, ctx.planner.id),
    'the watch should outlive the end'
  );

  expect(ended?.life).toBe('ended');
  expect(watch.suspendedAt).not.toBeNull();
  expect(watch.endAttemptRuns).toBe(0);
});

test('a failed platform stop is counted without loading the whole fleet again', async () => {
  const ctx = await team();
  const warned = spyOn(console, 'warn').mockImplementation(() => {});

  runAfterTest(() => warned.mockRestore());

  const implementer = await startImplementerOnFailedTask(ctx);
  let fleetLoads = 0;
  const store: Store = {
    ...ctx.deps.store,
    transact: work =>
      ctx.deps.store.transact(tx =>
        work({
          ...tx,
          loadFleet() {
            fleetLoads += 1;

            return tx.loadFleet();
          },
        })
      ),
  };

  ctx.simulated.queueError('end', 'unavailable');
  advance(ctx.deps, closedTaskGraceMs);
  await runReaper({ ...ctx.deps, store }, ctx.platforms, { workerId: 'worker' });

  const watch = await savedWatch(ctx.deps, implementer.id);

  expect(watch?.endAttemptRuns).toBe(1);
  expect(fleetLoads).toBe(1);
});

test('a settled ended session is not loaded into the next reaper run', async () => {
  const ctx = await team();

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'service' },
    reason: 'The planner is done.',
  });

  const fleet = await ctx.deps.store.transact(tx => tx.loadFleet());

  expect(fleet.sessions.map(session => session.id)).not.toContain(ctx.planner.id);
});

test('a pending stop of an ended session is finished, and a finished one is left', async () => {
  const ctx = await team();
  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true,
         platform_stop_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stopped = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(stopped?.final_usage_pending).toBe(false);
  expect(stopped?.platform_stop_pending).toBe(false);

  const ends = ctx.simulated.calls().filter(call => call === 'end').length;

  expect(ends).toBe(1);

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBe(ends);
});

test('a start that was never found is not searched again after the window', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  ctx.simulated.queueError('start', 'invalid');

  const refused = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'The platform refuses this start.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'never-found',
    bodyHash: 'never-found',
    replacementOf: null,
  });

  expect(refused.outcome).toBe('refused');

  advance(ctx.deps, searchWindowMs + 1000);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const finds = ctx.simulated.calls().filter(call => call === 'findByKey').length;

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'findByKey').length).toBe(finds);
});

async function startImplementerOnFailedTask(ctx: Awaited<ReturnType<typeof team>>) {
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'Implement the change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'cleanup',
    bodyHash: 'cleanup',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');
  if (started.outcome !== 'live') throw new Error('implementer did not start');

  const tasks = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);
  const childRow = requirePresent(
    tasks.find(task => task.id === child),
    'child'
  );

  await reportTransition(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    expectedVersion: childRow.version,
    actor: { kind: 'session', role: 'planner', sessionId: ctx.planner.id, live: true },
    to: 'failed',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  return started.session;
}

async function savedWatch(deps: TestDeps, sessionId: string) {
  const snapshot = await deps.store.transact(tx => tx.loadFleet());

  return snapshot.watches.find(item => item.sessionId === sessionId);
}

function advance(deps: TestDeps, ms: number): void {
  deps.clock.advance(ms);
}

async function addChild(deps: TestDeps, groupId: GroupId, plannerId: SessionId) {
  const tasks = await deps.store.tasks(defaultWorkspaceId, groupId);
  const root = tasks.find(task => task.parent_id === null);

  if (root?.state === 'planned') {
    await reportTransition(deps, {
      workspaceId: defaultWorkspaceId,
      groupId: root.group_id,
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
    groupId: root?.group_id ?? groupId,
    actor: { sessionId: plannerId, live: true },
    title: 'Tax interface',
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
  });

  return created.task.id;
}
