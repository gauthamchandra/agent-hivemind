import { expect, spyOn, test } from 'bun:test';
import { runReaper } from '@/core/reaper.ts';
import { writeReaperJobState } from '@/core/reaper-actions.ts';
import { reportTransition } from '@/core/report-records.ts';
import { noteActivity } from '@/core/session-activity.ts';
import { endSession } from '@/core/session-end.ts';
import { startSession } from '@/core/session-start.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import {
  closedTaskGraceMs,
  emptySessionJobState,
  reaperIntervalMs,
  searchWindowMs,
  startingResolveMs,
  suspendIdleMs,
} from '@/domain/background-jobs.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { PlatformError } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { Store } from '@/ports/storage.ts';
import { requirePresent } from '@/testing/assertions.ts';
import type { TestDeps } from '@/testing/deps.ts';
import { note } from '@/testing/fixtures.ts';
import { addChild, team } from '@/testing/team.ts';
import { runAfterTest } from '@/testing/teardown.ts';

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

test('a platform stop that fails is counted, kept as an open planned action, and retried on the next run', async () => {
  const ctx = await team();
  const warned = spyOn(console, 'warn').mockImplementation(() => {});

  runAfterTest(() => warned.mockRestore());

  const implementer = await startImplementerOnFailedTask(ctx);

  ctx.simulated.queueError('end', 'unavailable');
  advance(ctx.deps, closedTaskGraceMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const jobState = await savedJobState(ctx.deps, implementer.id);
  const stillLive = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);

  expect(jobState?.endAttemptRuns).toBe(1);
  expect(stillLive?.life).toBe('live');
  expect(warned).toHaveBeenCalledTimes(1);
  expect(warned.mock.calls[0]?.[0]).toContain('on its next run');
  expect(warned.mock.calls[0]?.[1]).toMatchObject({ code: 'unavailable' });
  expect(await ctx.deps.store.transact(tx => tx.openPlannedActions('reaper'))).toHaveLength(1);

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const retried = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);
  const open = await ctx.deps.store.transact(tx => tx.openPlannedActions('reaper'));

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

test('a reaper lock id that a later run replaced does not save the job state', async () => {
  const ctx = await team();
  const first = await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  advance(ctx.deps, reaperIntervalMs);

  const second = await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });
  const staleLockId = requirePresent(first.lockId, 'the first run should take the job lock');
  const currentLockId = requirePresent(second.lockId, 'the second run should take the job lock');
  const jobState = emptySessionJobState(ctx.planner.id, defaultWorkspaceId);

  jobState.endAttemptRuns = 4;
  jobState.lastFind = 'absent';
  jobState.inconclusiveRuns = 2;
  jobState.suspendedProgressAt = formatTime(ctx.deps.clock.now());

  await expect(writeReaperJobState(ctx.deps, staleLockId, jobState)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await savedJobState(ctx.deps, ctx.planner.id)).toBeUndefined();

  await writeReaperJobState(ctx.deps, currentLockId, jobState);

  expect(await savedJobState(ctx.deps, ctx.planner.id)).toMatchObject({
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
  const jobState = requirePresent(
    await savedJobState(ctx.deps, ctx.planner.id),
    'the suspension should be remembered'
  );

  expect(suspends()).toBe(1);
  expect(planner?.life).toBe('live');
  expect(jobState.suspendedAt).not.toBeNull();
});

test('a session that reports after the sessions were read is not suspended', async () => {
  const ctx = await team();
  const store: Store = {
    ...ctx.deps.store,
    transact: async work => {
      const result = await ctx.deps.store.transact(work);

      if (typeof result === 'object' && result !== null && 'sessionJobStates' in result) {
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
  const jobState = requirePresent(
    await savedJobState(ctx.deps, ctx.planner.id),
    'the job state should outlive the end'
  );

  expect(ended?.life).toBe('ended');
  expect(jobState.suspendedAt).not.toBeNull();
  expect(jobState.endAttemptRuns).toBe(0);
});

test('a failed platform stop is counted without loading all the sessions again', async () => {
  const ctx = await team();
  const warned = spyOn(console, 'warn').mockImplementation(() => {});

  runAfterTest(() => warned.mockRestore());

  const implementer = await startImplementerOnFailedTask(ctx);
  let snapshotLoads = 0;
  const store: Store = {
    ...ctx.deps.store,
    transact: work =>
      ctx.deps.store.transact(tx =>
        work({
          ...tx,
          loadJobSnapshot() {
            snapshotLoads += 1;

            return tx.loadJobSnapshot();
          },
        })
      ),
  };

  ctx.simulated.queueError('end', 'unavailable');
  advance(ctx.deps, closedTaskGraceMs);
  await runReaper({ ...ctx.deps, store }, ctx.platforms, { workerId: 'worker' });

  const jobState = await savedJobState(ctx.deps, implementer.id);

  expect(jobState?.endAttemptRuns).toBe(1);
  expect(snapshotLoads).toBe(1);
});

test('an ended session is loaded until the platform status confirms it stopped', async () => {
  const ctx = await team();

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'service' },
    reason: 'The planner is done.',
  });

  const idsLoaded = async () =>
    (await ctx.deps.store.transact(tx => tx.loadJobSnapshot())).sessions.map(session => session.id);

  expect(await idsLoaded()).toContain(ctx.planner.id);

  await ctx.db.query(`UPDATE sessions SET last_status = 'stopped' WHERE id = $1`, [ctx.planner.id]);

  expect(await idsLoaded()).not.toContain(ctx.planner.id);
});

test('an ended session with no platform reference is not loaded', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, token_hash = NULL, platform_session_ref = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );

  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  expect(snapshot.sessions.map(session => session.id)).not.toContain(ctx.planner.id);
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

async function savedJobState(deps: TestDeps, sessionId: string) {
  const snapshot = await deps.store.transact(tx => tx.loadJobSnapshot());

  return snapshot.sessionJobStates.find(item => item.sessionId === sessionId);
}

function advance(deps: TestDeps, ms: number): void {
  deps.clock.advance(ms);
}
