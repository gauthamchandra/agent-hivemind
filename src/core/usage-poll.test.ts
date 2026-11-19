import { expect, spyOn, test } from 'bun:test';
import { runDueJobs } from '@/core/background-jobs.ts';
import { runReaper } from '@/core/reaper.ts';
import { reportTransition } from '@/core/report-records.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { startSession } from '@/core/session-start.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { runUsagePoll } from '@/core/usage-poll.ts';
import { recordPollResult } from '@/core/usage-poll-result.ts';
import {
  emptySessionJobState,
  jobLockMs,
  reaperIntervalMs,
  recordsPerWorkspace,
  usagePollDeadlineMs,
  usagePollIntervalMs,
} from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  type ConnectionId,
  defaultWorkspaceId,
  type PersonId,
  type WorkspaceId,
} from '@/domain/ids.ts';
import { selfHostedLimits } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { PlatformAdapter, Platforms } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { note } from '@/testing/fixtures.ts';
import { simulatedAdapterName } from '@/testing/platforms.ts';
import { addChild, team } from '@/testing/team.ts';
import { runAfterTest } from '@/testing/teardown.ts';
import { waitUntil } from '@/testing/wait.ts';

type Ctx = Awaited<ReturnType<typeof team>>;

test('a run stores status and usage and sums spend in one unit', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'working');
  ctx.simulated.setSessionUsage(ref, 4);
  const run = await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(run.ran).toBe(true);
  expect(stored?.last_status).toBe('working');
  expect(stored?.usage).toBe('4');
  expect(group?.spend).toBe('4');
});

test('an ACU reading and a token reading stay on their own groups', async () => {
  const ctx = await team();

  ctx.simulated.setUsageUnit('acu', 'ACU');

  const tokenId = ctx.deps.ids.connection();
  const token = createSimulatedPlatform(tokenId, {
    usageUnit: 'token',
    usageUnitDisplay: 'Tokens',
  });
  const workspaceId = ctx.deps.ids.workspace();
  const personId = ctx.deps.ids.person();
  const now = formatTime(ctx.deps.clock.now());

  await ctx.deps.store.transact(async tx => {
    await tx.insertWorkspace({
      id: workspaceId,
      name: 'Tokens',
      status: 'active',
      limits: selfHostedLimits,
      created_at: now,
    });
    await tx.insertPerson({
      id: personId,
      workspace_id: workspaceId,
      display_name: 'Grace',
      workspace_role: 'administrator',
      account_id: null,
      status: 'active',
      created_at: now,
    });
  });
  await ctx.deps.store.saveConnection({
    workspaceId,
    id: tokenId,
    adapter: simulatedAdapterName,
    createdAt: now,
  });

  const platforms: Platforms = {
    require(id) {
      if (id === ctx.connectionId) {
        return { adapter: ctx.simulated.adapter, connection: ctx.simulated.connection() };
      }
      if (id === tokenId) return { adapter: token.adapter, connection: token.connection() };

      throw new HivemindError('not_found', 'No connection with that identifier exists.');
    },
  };
  const other = await openGroup(ctx.deps, platforms, {
    workspaceId,
    personId,
    name: 'Tokens',
    goal: 'Count tokens without adding them to the other group.',
    budget: '5000',
    connectionId: tokenId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the token work.',
    idempotencyKey: 'token-group',
    bodyHash: 'token-group',
  });

  expect(other.outcome).toBe('live');
  if (other.outcome !== 'live') throw new Error('token planner did not start');

  const acuRef = requirePresent(ctx.planner.platform_session_ref, 'acu ref');
  const tokenRef = requirePresent(other.session.platform_session_ref, 'token ref');

  ctx.simulated.setSessionUsage(acuRef, 4);
  token.setSessionUsage(tokenRef, 1000);
  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const acuGroup = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const tokenGroup = await ctx.deps.store.group(workspaceId, other.group.id);

  expect(ctx.simulated.adapter.describe().usageUnit).toBe('acu');
  expect(token.adapter.describe().usageUnit).toBe('token');
  expect(acuGroup?.spend).toBe('4');
  expect(tokenGroup?.spend).toBe('1000');
});

test('a transition between runs makes no platform call', async () => {
  const ctx = await team();
  const before = ctx.simulated.calls().length;

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

  expect(ctx.simulated.calls().length).toBe(before);
});

test('a reached budget refuses the next start', async () => {
  const ctx = await team();

  ctx.simulated.controls.setReportedUsage(100);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  await expect(
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId: child,
      role: 'implementer',
      instructions: 'This start should be refused.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: 'over-budget',
      bodyHash: 'over-budget',
      replacementOf: null,
    })
  ).rejects.toMatchObject({ code: 'cap_reached', details: { cap: 'budget' } });
});

test('a missing usage read leaves the final reading due, and zero clears it', async () => {
  quietWarnings();

  const ctx = await team();
  let readUsage = async (): Promise<number> => {
    throw new PlatformError('unavailable', 'The platform did not answer.');
  };
  const platforms = withAdapter(ctx, { readUsage: () => readUsage() });

  await ctx.db.query(
    `UPDATE sessions
     SET final_usage_pending = true, life = 'ended', ended_at = created_at, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const pending = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(pending?.final_usage_pending).toBe(true);

  readUsage = async () => 0;
  ctx.deps.clock.advance(usagePollIntervalMs);
  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const cleared = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(cleared?.final_usage_pending).toBe(false);
  expect(cleared?.usage).toBe('0');
});

test('a usage poll write does not erase the reaper fields', async () => {
  const ctx = await team();
  const base = emptySessionJobState(ctx.planner.id, defaultWorkspaceId);

  await ctx.deps.store.transact(async tx => {
    await tx.saveSessionJobState({ ...base, endAttemptRuns: 7 }, 'reaper');
    await tx.saveSessionJobState(
      { ...base, endAttemptRuns: 0, lastReadingAt: '2026-11-16T00:05:00.000Z' },
      'usage_poll'
    );
  });

  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());
  const jobState = requirePresent(
    snapshot.sessionJobStates.find(item => item.sessionId === ctx.planner.id),
    'the jobState should exist'
  );

  expect(jobState.endAttemptRuns).toBe(7);
  expect(jobState.lastReadingAt).toBe('2026-11-16T00:05:00.000Z');

  await ctx.deps.store.transact(tx =>
    tx.saveSessionJobState({ ...base, endAttemptRuns: 3, lastReadingAt: null }, 'reaper')
  );

  const afterReaper = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());
  const kept = requirePresent(
    afterReaper.sessionJobStates.find(item => item.sessionId === ctx.planner.id),
    'the jobState should exist'
  );

  expect(kept.endAttemptRuns).toBe(3);
  expect(kept.lastReadingAt).toBe('2026-11-16T00:05:00.000Z');
});

test('an old lock id cannot overwrite the poll result the next worker stored', async () => {
  const ctx = await team();
  const stopped = await runUsagePoll(ctx.deps, ctx.platforms, {
    workerId: 'first-worker',
    crashAt: 'after_planned_action',
  }).catch(error => error);

  expect(stopped).toBeInstanceOf(StoppedProcess);

  const oldLockId = await currentLockId(ctx);

  ctx.deps.clock.advance(usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'next' });

  const session = requirePresent(
    await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id),
    'planner'
  );

  await expect(
    recordPollResult(ctx.deps, {
      lockId: oldLockId,
      session,
      status: 'failed',
      reading: 9,
      settlesFinalReading: false,
      jobState: {
        ...emptySessionJobState(session.id, session.workspace_id),
        lastReadingAt: '2026-11-16T00:09:00.000Z',
      },
    })
  ).rejects.toMatchObject({ code: 'conflict' });
  expect((await ctx.deps.store.session(defaultWorkspaceId, session.id))?.last_status).not.toBe(
    'failed'
  );
});

test('a failed read is remembered without becoming a successful reading', async () => {
  const ctx = await team();
  quietWarnings();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 4);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const before = await ctx.db.query<{ last_reading_at: string | null }>(
    'SELECT last_reading_at FROM session_job_state WHERE session_id = $1',
    [ctx.planner.id]
  );
  const firstRunAt = Date.parse(formatTime(ctx.deps.clock.now()));
  const readingAt = requirePresent(
    before.rows[0]?.last_reading_at,
    'the first run should store when it read the usage'
  );

  expect(Date.parse(readingAt)).toBe(firstRunAt);

  ctx.deps.clock.advance(usagePollIntervalMs);

  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async () => {
            throw new PlatformError('unavailable', 'The platform did not answer.');
          },
        },
      };
    },
  };

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const after = await ctx.db.query<{
    last_reading_at: string | null;
    last_attempt_at: string | null;
  }>('SELECT last_reading_at, last_attempt_at FROM session_job_state WHERE session_id = $1', [
    ctx.planner.id,
  ]);

  const stored = requirePresent(after.rows[0], 'the job state should still exist');
  const secondRunAt = Date.parse(formatTime(ctx.deps.clock.now()));

  expect(stored.last_reading_at).toEqual(readingAt);
  expect(Date.parse(requirePresent(stored.last_attempt_at, 'the attempt time'))).toBe(secondRunAt);
});

test('a later attempt waits behind a session that has not been tried', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'The other session.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'attempt-order',
    bodyHash: 'attempt-order',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');
  if (started.outcome !== 'live') throw new Error('implementer did not start');

  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const recent = formatTime(ctx.deps.clock.now());
  const older = formatTime(new Date(ctx.deps.clock.now().getTime() - 60_000));

  await ctx.db.query(
    'UPDATE session_job_state SET last_attempt_at = $2::timestamptz WHERE session_id = $1',
    [ctx.planner.id, recent]
  );
  await ctx.db.query(
    'UPDATE session_job_state SET last_attempt_at = $2::timestamptz WHERE session_id = $1',
    [started.session.id, older]
  );
  ctx.deps.clock.advance(usagePollIntervalMs);

  const order: string[] = [];
  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async (connection, ref) => {
            order.push(ref);

            return handle.adapter.readStatus(connection, ref);
          },
        },
      };
    },
  };

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const plannerRef = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const implementerRef = requirePresent(started.session.platform_session_ref, 'implementer ref');

  expect(order).toContain(implementerRef);
  expect(order).toContain(plannerRef);
  expect(order.indexOf(implementerRef)).toBeLessThan(order.indexOf(plannerRef));
});

test('a slow workspace does not keep the next workspace from being read', async () => {
  const ctx = await team();

  await startOtherSession(ctx, 'slow-workspace');

  const second = await addWorkspace(ctx, 'Second');
  const platforms = platformsWith(ctx, [second]);
  const secondRef = await startPlannerIn(ctx, platforms, second);
  const seen: string[] = [];

  await runUsagePoll(ctx.deps, readingSlowly(ctx, platforms, seen), { workerId: 'worker' });

  expect(seen).toContain(secondRef);
});

test('a workspace that came late in the order is read first on the next run', async () => {
  const ctx = await team();
  const second = await addWorkspace(ctx, 'Second');
  const third = await addWorkspace(ctx, 'Third');
  const platforms = platformsWith(ctx, [second, third]);

  await startPlannerIn(ctx, platforms, second);

  const thirdRef = await startPlannerIn(ctx, platforms, third);
  const seen: string[] = [];
  const reading = readingSlowly(ctx, platforms, seen);

  ctx.deps.clock.advance(1000);
  await runUsagePoll(ctx.deps, reading, { workerId: 'worker' });
  expect(seen).not.toContain(thirdRef);

  ctx.deps.clock.advance(usagePollIntervalMs);
  seen.length = 0;
  await runUsagePoll(ctx.deps, reading, { workerId: 'worker' });

  expect(seen[0]).toBe(thirdRef);
});

test('a workspace with an older unread session is read before one that gained a newer session', async () => {
  const ctx = await team();
  const second = await addWorkspace(ctx, 'Second');
  const platforms = platformsWith(ctx, [second]);

  ctx.deps.clock.advance(60_000);

  const secondRef = await startPlannerIn(ctx, platforms, second);

  ctx.deps.clock.advance(60_000);
  await startOtherSession(ctx, 'newer-session-in-the-first-workspace');

  const seen: string[] = [];
  const reading = readingSlowly(ctx, platforms, seen, usagePollDeadlineMs + 1000);

  await runUsagePoll(ctx.deps, reading, { workerId: 'worker' });
  ctx.deps.clock.advance(usagePollIntervalMs);
  seen.length = 0;
  await runUsagePoll(ctx.deps, reading, { workerId: 'worker' });

  expect(seen).toEqual([secondRef]);
});

test('a workspace not read for longer is read before one whose session is new', async () => {
  const ctx = await team();
  const second = await addWorkspace(ctx, 'Second');
  const platforms = platformsWith(ctx, [second]);
  const secondRef = await startPlannerIn(ctx, platforms, second);

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const longAgo = formatTime(new Date(ctx.deps.clock.now().getTime() - 60 * 60_000));
  const recent = formatTime(ctx.deps.clock.now());

  await ctx.db.query(
    'UPDATE session_job_state SET last_attempt_at = $2::timestamptz WHERE session_id = $1',
    [ctx.planner.id, recent]
  );
  await ctx.db.query(
    `UPDATE session_job_state SET last_attempt_at = $1::timestamptz
     WHERE session_id <> $2`,
    [longAgo, ctx.planner.id]
  );
  ctx.deps.clock.advance(usagePollIntervalMs);
  await startOtherSession(ctx, 'new-session-in-the-first-workspace');

  const seen: string[] = [];

  await runUsagePoll(ctx.deps, readingSlowly(ctx, platforms, seen, usagePollDeadlineMs + 1000), {
    workerId: 'worker',
  });

  expect(seen).toEqual([secondRef]);
});

test('a poll result that does not fit the deadline stays open', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'This poll result should wait.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'wait-poll-result',
    bodyHash: 'wait-poll-result',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');
  if (started.outcome !== 'live') throw new Error('implementer did not start');

  const now = formatTime(ctx.deps.clock.now());

  await ctx.db.query(
    `INSERT INTO planned_actions (
       id, job, action, target_id, workspace_id, lock_id, state, created_at
     ) VALUES
       ('slow-planned-action', 'usage_poll', 'poll', $1, $2, 1, 'open', $3::timestamptz),
       ('later-planned-action', 'usage_poll', 'poll', $4, $2, 1, 'open', $5::timestamptz)`,
    [
      ctx.planner.id,
      defaultWorkspaceId,
      now,
      started.session.id,
      formatTime(new Date(ctx.deps.clock.now().getTime() + 1000)),
    ]
  );

  const plannerRef = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const seen: string[] = [];
  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async (connection, ref) => {
            seen.push(ref);
            if (ref === plannerRef) ctx.deps.clock.advance(usagePollDeadlineMs + 1000);

            return handle.adapter.readStatus(connection, ref);
          },
        },
      };
    },
  };

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const plannedActions = await ctx.deps.store.transact(tx => tx.openPlannedActions('usage_poll'));
  const implementerRef = requirePresent(started.session.platform_session_ref, 'implementer ref');

  expect(seen.filter(ref => ref === plannerRef)).toHaveLength(1);
  expect(seen).not.toContain(implementerRef);
  expect(
    plannedActions.find(plannedAction => plannedAction.id === 'later-planned-action')?.state
  ).toBe('open');
});

test('a read longer than the job lock still records spend', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 100);

  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async (connection, sessionRef) => {
            ctx.deps.clock.advance(jobLockMs + 1000);

            return handle.adapter.readStatus(connection, sessionRef);
          },
        },
      };
    },
  };

  const run = await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(run.ran).toBe(true);
  expect((await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id))?.spend).toBe('100');
});

test('one bad open poll result does not stop the rest of the run', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'The other session.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'other-session',
    bodyHash: 'other-session',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');

  const plannerRef = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readUsage: async (connection, ref) => {
            if (ref === plannerRef) return Number.NaN;

            return handle.adapter.readUsage(connection, ref);
          },
        },
      };
    },
  };
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());

  const first = await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(first.ran).toBe(true);

  errors.mockClear();
  ctx.simulated.setSessionStatus(
    requirePresent(started.session.platform_session_ref, 'implementer ref'),
    'idle'
  );
  ctx.deps.clock.advance(usagePollIntervalMs);

  const second = await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
  const implementer = await ctx.deps.store.session(defaultWorkspaceId, started.session.id);

  expect(second.ran).toBe(true);
  expect(implementer?.last_status).toBe('idle');
  expect(errors.mock.calls.some(call => String(call[0]).includes(ctx.planner.id))).toBe(true);
  expect(errors.mock.calls.some(call => call[1] instanceof Error)).toBe(true);
});

test('an unreliable connection is logged once and not read again for the next session', async () => {
  const ctx = await team();

  await startOtherSession(ctx, 'same-connection');

  let reads = 0;
  const platforms = withAdapter(ctx, {
    readStatus: async () => {
      reads += 1;

      throw new PlatformError('auth', 'The platform refused the credential.');
    },
  });
  const warned = quietWarnings();

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(reads).toBe(1);
  expect(warned).toHaveBeenCalledTimes(1);
  expect(String(warned.mock.calls[0]?.[0])).toContain(ctx.connectionId);
  expect(String(warned.mock.calls[0]?.[0])).toContain('auth');
});

test('a reading taken while the platform stop is pending leaves the final reading due', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 5);
  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true,
         platform_stop_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const read = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(read?.usage).toBe('5');
  expect(read?.final_usage_pending).toBe(true);
  expect(read?.platform_stop_pending).toBe(true);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(0);

  ctx.simulated.setSessionUsage(ref, 9);
  ctx.deps.clock.advance(reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stopped = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(stopped?.platform_stop_pending).toBe(false);
  expect(stopped?.final_usage_pending).toBe(false);
  expect(stopped?.usage).toBe('9');
  expect(group?.spend).toBe('9');
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(1);
});

test('a reading taken before the session ended leaves the final reading due', async () => {
  const ctx = await team();
  const run = await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  const whileRunning = requirePresent(
    await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id),
    'planner'
  );

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await recordPollResult(ctx.deps, {
    lockId: requirePresent(run.lockId, 'run lockId'),
    session: whileRunning,
    status: null,
    reading: 3,
    settlesFinalReading: false,
    jobState: emptySessionJobState(whileRunning.id, whileRunning.workspace_id),
  });

  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(stored?.usage).toBe('3');
  expect(stored?.final_usage_pending).toBe(true);
});

test('a later run adds only the increase, and a smaller reading changes nothing', async () => {
  const ctx = await team();
  const readings = [4, 6, 2];
  let next = 0;
  const platforms = withAdapter(ctx, { readUsage: async () => readings[next++] ?? 0 });

  for (let run = 0; run < readings.length; run += 1) {
    await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
    ctx.deps.clock.advance(usagePollIntervalMs);
  }

  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(group?.spend).toBe('6');
  expect(stored?.usage).toBe('6');
});

test('a worker that lost the job lock cannot record an attempt', async () => {
  const ctx = await team();
  const takeover = { armed: false, taken: false };
  const store = new Proxy(ctx.deps.store, {
    get(target, property) {
      const member = Reflect.get(target, property, target);

      if (property !== 'transact')
        return typeof member === 'function' ? member.bind(target) : member;

      return async (work: (tx: UnitOfWork) => Promise<unknown>) => {
        if (takeover.armed && !takeover.taken) {
          takeover.taken = true;
          ctx.deps.clock.advance(usagePollIntervalMs);
          await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'next' });
        }

        return target.transact(tx =>
          work(
            new Proxy(tx, {
              get(inner, key) {
                const call = Reflect.get(inner, key, inner);

                if (key === 'insertPlannedAction') takeover.armed = true;

                return typeof call === 'function' ? call.bind(inner) : call;
              },
            })
          )
        );
      };
    },
  });
  const staleAt = ctx.deps.clock.now().getTime();

  await expect(
    runUsagePoll({ ...ctx.deps, store }, ctx.platforms, { workerId: 'first-worker' })
  ).rejects.toMatchObject({ code: 'conflict' });

  const rows = await ctx.db.query<{ last_attempt_at: string }>(
    'SELECT last_attempt_at FROM session_job_state WHERE session_id = $1',
    [ctx.planner.id]
  );

  expect(takeover.taken).toBe(true);
  expect(new Date(requirePresent(rows.rows[0], 'jobState row').last_attempt_at).getTime()).toBe(
    staleAt + usagePollIntervalMs
  );
});

test('a session that keeps failing does not keep the rest of its connection from being read', async () => {
  const ctx = await team();
  quietWarnings();
  const other = await startOtherSession(ctx, 'poison-neighbour');
  const plannerRef = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const otherRef = requirePresent(other.platform_session_ref, 'other ref');
  const seen: string[] = [];
  const platforms = withAdapter(ctx, {
    readStatus: async (connection, ref) => {
      seen.push(ref);
      if (ref === plannerRef)
        throw new PlatformError('unavailable', 'The platform did not answer.');

      return ctx.simulated.adapter.readStatus(connection, ref);
    },
  });

  for (let run = 0; run < 3; run += 1) {
    await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
    ctx.deps.clock.advance(usagePollIntervalMs);
  }

  expect(seen).toContain(otherRef);
  expect((await ctx.deps.store.session(defaultWorkspaceId, other.id))?.last_status).toBe('working');
});

test('a failing open poll result is read once per run', async () => {
  const ctx = await team();
  let plannerReads = 0;
  const platforms = withAdapter(ctx, {
    readUsage: async () => {
      plannerReads += 1;

      return Number.NaN;
    },
  });
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());
  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
  ctx.deps.clock.advance(usagePollIntervalMs);
  plannerReads = 0;
  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(plannerReads).toBe(1);
});

test('a failed start without a platform reference is not polled', async () => {
  const ctx = await team();
  const other = await startOtherSession(ctx, 'failed-start');

  await ctx.db.query(
    `UPDATE sessions SET life = 'start_failed', platform_session_ref = NULL, token_hash = NULL
     WHERE id = $1`,
    [other.id]
  );
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const plannedActions = await allPlannedActions(ctx);

  expect(plannedActions.some(plannedAction => plannedAction.target_id === ctx.planner.id)).toBe(
    true
  );
  expect(plannedActions.some(plannedAction => plannedAction.target_id === other.id)).toBe(false);
});

test('a failed start that recovery has settled leaves the snapshot and is not polled', async () => {
  const ctx = await team();
  const other = await startOtherSession(ctx, 'settled-failed-start');

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'start_failed', token_hash = NULL, final_usage_pending = false,
         platform_stop_pending = false
     WHERE id = $1`,
    [other.id]
  );

  const settled = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const plannedActions = await allPlannedActions(ctx);

  expect(settled.sessions.some(session => session.id === other.id)).toBe(false);
  expect(plannedActions.some(plannedAction => plannedAction.target_id === other.id)).toBe(false);

  await ctx.db.query('UPDATE sessions SET platform_stop_pending = true WHERE id = $1', [other.id]);

  const owingStop = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  expect(owingStop.sessions.some(session => session.id === other.id)).toBe(true);
});

test('a session on a connection already marked unreliable records no planned action', async () => {
  const ctx = await team();
  quietWarnings();
  await startOtherSession(ctx, 'skipped-neighbour');

  const platforms = withAdapter(ctx, {
    readStatus: async () => {
      throw new PlatformError('unavailable', 'The platform did not answer.');
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(await allPlannedActions(ctx)).toHaveLength(1);
});

test('a failed usage read still keeps the status', async () => {
  const ctx = await team();
  quietWarnings();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'idle');

  const platforms = withAdapter(ctx, {
    readUsage: async () => {
      throw new PlatformError('unavailable', 'The platform did not answer.');
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect((await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id))?.last_status).toBe(
    'idle'
  );
});

test('a failed usage read does not become a successful reading', async () => {
  const ctx = await team();
  quietWarnings();

  const platforms = withAdapter(ctx, {
    readUsage: async () => {
      throw new PlatformError('unavailable', 'The platform did not answer.');
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const rows = await ctx.db.query<{ last_reading_at: string | null; last_attempt_at: string }>(
    'SELECT last_reading_at, last_attempt_at FROM session_job_state WHERE session_id = $1',
    [ctx.planner.id]
  );

  expect(rows.rows[0]?.last_reading_at).toBeNull();
  expect(rows.rows[0]?.last_attempt_at).not.toBeNull();
});

test('a connection without usage reading is not asked for usage', async () => {
  const ctx = await team();

  ctx.simulated.drop('usage_reading');
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(ctx.simulated.calls()).not.toContain('readUsage');
  expect(stored?.last_status).toBe('working');
  expect(stored?.usage).toBeNull();
});

test('two sessions of one group add their increases to the same spend', async () => {
  const ctx = await team();
  const other = await startOtherSession(ctx, 'two-sessions');

  ctx.simulated.setSessionUsage(requirePresent(ctx.planner.platform_session_ref, 'ref'), 1.5);
  ctx.simulated.setSessionUsage(requirePresent(other.platform_session_ref, 'ref'), 2.5);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect((await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id))?.spend).toBe('4');
});

test('an ended session the platform no longer knows is recorded as stopped and not read again', async () => {
  const ctx = await team();
  const ended = await startOtherSession(ctx, 'ended-unknown');

  await ctx.db.query(
    `UPDATE sessions SET life = 'ended', ended_at = created_at, token_hash = NULL WHERE id = $1`,
    [ended.id]
  );

  let endedReads = 0;
  const platforms = withAdapter(ctx, {
    readStatus: async (connection, ref) => {
      if (ref !== ended.platform_session_ref)
        return ctx.simulated.adapter.readStatus(connection, ref);

      endedReads += 1;
      throw new PlatformError('not_found', 'The platform has no such session.');
    },
  });

  for (let run = 0; run < 2; run += 1) {
    await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
    ctx.deps.clock.advance(usagePollIntervalMs);
  }

  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  expect(endedReads).toBe(1);
  expect((await ctx.deps.store.session(defaultWorkspaceId, ended.id))?.last_status).toBe('stopped');
  expect(snapshot.sessions.map(session => session.id)).not.toContain(ended.id);
});

test.each(['ended', 'start_failed'] as const)(
  'a session that is %s and that the platform forgot while owing its final reading is settled and not read again',
  async life => {
    const ctx = await team();
    const ended = await startOtherSession(ctx, 'closed-owing-reading');

    await ctx.db.query(
      `UPDATE sessions
     SET life = $2, ended_at = created_at, token_hash = NULL, usage = NULL,
         final_usage_pending = true, platform_stop_pending = false
     WHERE id = $1`,
      [ended.id, life]
    );

    const spendBefore = (await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id))
      ?.spend;
    let endedReads = 0;
    const platforms = withAdapter(ctx, {
      readStatus: async (connection, ref) => {
        if (ref !== ended.platform_session_ref)
          return ctx.simulated.adapter.readStatus(connection, ref);

        endedReads += 1;
        throw new PlatformError('not_found', 'The platform has no such session.');
      },
      readUsage: async (connection, ref) => {
        if (ref !== ended.platform_session_ref)
          return ctx.simulated.adapter.readUsage(connection, ref);

        throw new PlatformError('not_found', 'The platform has no such session.');
      },
    });

    for (let run = 0; run < 2; run += 1) {
      await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
      ctx.deps.clock.advance(usagePollIntervalMs);
    }

    const settled = await ctx.deps.store.session(defaultWorkspaceId, ended.id);
    const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
    const lastReadingRows = await ctx.db.query<{ last_reading_at: string | null }>(
      'SELECT last_reading_at FROM session_job_state WHERE session_id = $1',
      [ended.id]
    );
    const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

    expect(settled?.final_usage_pending).toBe(false);
    expect(settled?.usage).toBeNull();
    expect(lastReadingRows.rows[0]?.last_reading_at).toBeNull();
    expect(group?.spend).toBe(spendBefore);
    expect(endedReads).toBe(1);
    expect(snapshot.sessions.map(session => session.id)).not.toContain(ended.id);
  }
);

test('the job snapshot leaves out the state of a session that is settled', async () => {
  const ctx = await team();

  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stateIds = async () =>
    (await ctx.deps.store.transact(tx => tx.loadJobSnapshot())).sessionJobStates.map(
      jobState => jobState.sessionId
    );

  expect(await stateIds()).toContain(ctx.planner.id);

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, token_hash = NULL, last_status = 'stopped'
     WHERE id = $1`,
    [ctx.planner.id]
  );

  expect(await stateIds()).not.toContain(ctx.planner.id);
});

test('a live session the platform does not know keeps no status', async () => {
  const ctx = await team();
  const platforms = withAdapter(ctx, {
    readStatus: async () => {
      throw new PlatformError('not_found', 'The platform has no such session.');
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(
    (await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id))?.last_status
  ).toBeNull();
});

test('the next worker finishes an open planned action without writing a second one', async () => {
  const ctx = await team();
  const stopped = await runUsagePoll(ctx.deps, ctx.platforms, {
    workerId: 'first-worker',
    crashAt: 'after_planned_action',
  }).catch(error => error);

  expect(stopped).toBeInstanceOf(StoppedProcess);

  ctx.deps.clock.advance(usagePollIntervalMs);

  let reads = 0;
  const platforms = withAdapter(ctx, {
    readStatus: async (connection, ref) => {
      reads += 1;

      return ctx.simulated.adapter.readStatus(connection, ref);
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'next' });

  const plannedActions = (await allPlannedActions(ctx)).filter(
    plannedAction => plannedAction.target_id === ctx.planner.id
  );

  expect(plannedActions).toHaveLength(1);
  expect(plannedActions[0]?.state).toBe('done');
  expect(reads).toBe(1);
});

test('a planned action for a session that is no longer in the snapshot is finished', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, token_hash = NULL, last_status = 'stopped'
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await ctx.db.query(
    `INSERT INTO planned_actions (
       id, job, action, target_id, workspace_id, lock_id, state, created_at
     ) VALUES ('gone-planned-action', 'usage_poll', 'poll', $1, $2, 1, 'open', $3::timestamptz)`,
    [ctx.planner.id, defaultWorkspaceId, formatTime(ctx.deps.clock.now())]
  );
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const plannedActions = await allPlannedActions(ctx);

  expect(
    plannedActions.find(plannedAction => plannedAction.id === 'gone-planned-action')?.state
  ).toBe('done');
});

test('a workspace is read up to its cap, and a planned action outside the cap stays open', async () => {
  const ctx = await team();

  await ctx.db.query(
    `INSERT INTO sessions
     SELECT (jsonb_populate_record(NULL::sessions, to_jsonb(s) || jsonb_build_object(
       'id', substr(s.id, 1, 14) || lpad(g::text, 16, '0'),
       'life', 'ended',
       'token_hash', NULL,
       'platform_session_ref', 'plat_clone' || g,
       'created_at', (s.created_at + g * interval '1 second')::text,
       'ended_at', (s.created_at + g * interval '1 second')::text
     ))).*
     FROM sessions s, generate_series(1, $2::int) AS g
     WHERE s.id = $1`,
    [ctx.planner.id, recordsPerWorkspace + 1]
  );
  await ctx.db.query(
    `INSERT INTO planned_actions (
       id, job, action, target_id, workspace_id, lock_id, state, created_at
     ) VALUES ('outside-cap', 'usage_poll', 'poll', $1, $2, 1, 'open', $3::timestamptz)`,
    [
      `${ctx.planner.id.slice(0, 14)}${String(recordsPerWorkspace + 1).padStart(16, '0')}`,
      defaultWorkspaceId,
      formatTime(ctx.deps.clock.now()),
    ]
  );

  let reads = 0;
  const platforms = withAdapter(ctx, {
    readStatus: async (connection, ref) => {
      reads += 1;

      return ctx.simulated.adapter.readStatus(connection, ref);
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  const plannedActions = await ctx.deps.store.transact(tx => tx.openPlannedActions('usage_poll'));

  expect(reads).toBe(recordsPerWorkspace);
  expect(plannedActions.find(plannedAction => plannedAction.id === 'outside-cap')?.state).toBe(
    'open'
  );
});

async function currentLockId(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<{ lock_id: number }>(
    `SELECT lock_id FROM job_locks WHERE job = 'usage_poll'`
  );

  return Number(requirePresent(rows.rows[0], 'the usage poll job lock row').lock_id);
}

async function allPlannedActions(ctx: Ctx) {
  const rows = await ctx.db.query<{ id: string; target_id: string; state: string }>(
    `SELECT id, target_id, state FROM planned_actions WHERE job = 'usage_poll' ORDER BY created_at, id`
  );

  return rows.rows;
}

test('a session whose read keeps failing slowly does not keep the others from being read', async () => {
  const ctx = await team();
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());

  const other = await startOtherSession(ctx, 'slow-failing-neighbour');

  ctx.deps.clock.advance(1000);

  const plannerRef = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const otherRef = requirePresent(other.platform_session_ref, 'other ref');
  const seen: string[] = [];
  const platforms = withAdapter(ctx, {
    readStatus: async (connection, ref) => {
      seen.push(ref);

      if (ref === plannerRef) {
        ctx.deps.clock.advance(usagePollDeadlineMs + 1000);
        throw new Error('The platform sent something unreadable.');
      }

      return ctx.simulated.adapter.readStatus(connection, ref);
    },
  });

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
  ctx.deps.clock.advance(usagePollIntervalMs);
  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(seen).toContain(otherRef);
  expect((await ctx.deps.store.session(defaultWorkspaceId, other.id))?.last_status).toBe('working');
});

test('a usage poll stuck on a platform read does not stop the reaper from running', async () => {
  const ctx = await team();
  let release = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let pollReadStarted = false;
  const platforms = withAdapter(ctx, {
    readStatus: async (connection, ref) => {
      pollReadStarted = true;
      await gate;

      return ctx.simulated.adapter.readStatus(connection, ref);
    },
  });

  await stopEndHalfway(ctx);

  const running = runDueJobs(ctx.deps, platforms, { workerId: 'worker' });

  runAfterTest(async () => {
    release();
    await running.catch(() => undefined);
  });
  await waitUntil(
    async () => (pollReadStarted ? true : null),
    'the poll to block on a platform read'
  );
  await waitUntil(async () => {
    const planner = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

    return planner?.life === 'ended' ? true : null;
  }, 'the reaper to finish the end while the poll is stuck');
  release();
  await running;
});

test('a usage poll that fails does not stop the reaper from running, and its error still surfaces', async () => {
  const ctx = await team();
  const platforms = withAdapter(ctx, {
    readStatus: async () => {
      throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
    },
  });

  await stopEndHalfway(ctx);
  await expect(runDueJobs(ctx.deps, platforms, { workerId: 'worker' })).rejects.toMatchObject({
    code: 'conflict',
  });

  const planner = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(planner?.life).toBe('ended');
});

test('a live session the poll saw stopped still holds its role until it ends', async () => {
  const ctx = await team();
  const other = await startOtherSession(ctx, 'looks-dead');

  ctx.simulated.setSessionStatus(
    requirePresent(other.platform_session_ref, 'other ref'),
    'stopped'
  );
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const polled = await ctx.deps.store.session(defaultWorkspaceId, other.id);

  expect(polled?.last_status).toBe('stopped');
  expect(polled?.life).toBe('live');
  await expect(
    startSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      groupId: ctx.opened.group.id,
      taskId: other.task_id,
      role: 'implementer',
      instructions: 'Replace the session that looks dead.',
      actor: { kind: 'session', sessionId: ctx.planner.id },
      idempotencyKey: 'replace-live-session',
      bodyHash: 'replace-live-session',
      replacementOf: other.id,
    })
  ).rejects.toMatchObject({
    code: 'conflict',
    message: 'This role on this task already has a session.',
  });
});

async function stopEndHalfway(ctx: Ctx): Promise<void> {
  await expect(
    endSession(ctx.deps, ctx.platforms, {
      workspaceId: defaultWorkspaceId,
      sessionId: ctx.planner.id,
      actor: { kind: 'service' },
      reason: 'Stop halfway.',
      crashAt: 'after_end_intent',
    })
  ).rejects.toBeInstanceOf(StoppedProcess);
}

type OtherWorkspace = {
  id: WorkspaceId;
  personId: PersonId;
  connectionId: ConnectionId;
  platform: ReturnType<typeof createSimulatedPlatform>;
};

async function addWorkspace(ctx: Ctx, name: string): Promise<OtherWorkspace> {
  const connectionId = ctx.deps.ids.connection();
  const workspace: OtherWorkspace = {
    id: ctx.deps.ids.workspace(),
    personId: ctx.deps.ids.person(),
    connectionId,
    platform: createSimulatedPlatform(connectionId),
  };
  const now = formatTime(ctx.deps.clock.now());

  await ctx.deps.store.transact(async tx => {
    await tx.insertWorkspace({
      id: workspace.id,
      name,
      status: 'active',
      limits: selfHostedLimits,
      created_at: now,
    });
    await tx.insertPerson({
      id: workspace.personId,
      workspace_id: workspace.id,
      display_name: name,
      workspace_role: 'administrator',
      account_id: null,
      status: 'active',
      created_at: now,
    });
  });
  await ctx.deps.store.saveConnection({
    workspaceId: workspace.id,
    id: workspace.connectionId,
    adapter: simulatedAdapterName,
    createdAt: now,
  });

  return workspace;
}

function platformsWith(ctx: Ctx, others: OtherWorkspace[]): Platforms {
  return {
    require(id) {
      if (id === ctx.connectionId) {
        return { adapter: ctx.simulated.adapter, connection: ctx.simulated.connection() };
      }

      const other = others.find(item => item.connectionId === id);

      if (other === undefined) {
        throw new HivemindError('not_found', 'No connection with that identifier exists.');
      }

      return { adapter: other.platform.adapter, connection: other.platform.connection() };
    },
  };
}

async function startPlannerIn(
  ctx: Ctx,
  platforms: Platforms,
  workspace: OtherWorkspace
): Promise<string> {
  const opened = await openGroup(ctx.deps, platforms, {
    workspaceId: workspace.id,
    personId: workspace.personId,
    name: `Group ${workspace.id}`,
    goal: 'A workspace that must still be read.',
    budget: '100',
    connectionId: workspace.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the workspace.',
    idempotencyKey: `group-${workspace.id}`,
    bodyHash: `group-${workspace.id}`,
  });

  if (opened.outcome !== 'live') throw new Error('the planner did not start');

  return requirePresent(opened.session.platform_session_ref, 'planner ref');
}

function readingSlowly(
  ctx: Ctx,
  platforms: Platforms,
  seen: string[],
  readMs = usagePollDeadlineMs / 2 + 1000
): Platforms {
  return {
    require(id) {
      const handle = platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async (connection, ref) => {
            seen.push(ref);
            ctx.deps.clock.advance(readMs);

            return handle.adapter.readStatus(connection, ref);
          },
        },
      };
    },
  };
}

function withAdapter(ctx: Ctx, overrides: Partial<PlatformAdapter>): Platforms {
  return {
    require(id) {
      const handle = ctx.platforms.require(id);

      return { connection: handle.connection, adapter: { ...handle.adapter, ...overrides } };
    },
  };
}

async function startOtherSession(ctx: Ctx, key: string) {
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'The other session.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: key,
    bodyHash: key,
    replacementOf: null,
  });

  if (started.outcome !== 'live') throw new Error('the other session did not start');

  return started.session;
}

function quietWarnings() {
  const warned = spyOn(console, 'warn').mockImplementation(() => undefined);

  runAfterTest(() => warned.mockRestore());

  return warned;
}
