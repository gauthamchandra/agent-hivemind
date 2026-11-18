import { expect, test } from 'bun:test';
import { escalateSession } from '@/core/escalate.ts';
import { commitObservation, runFleetCheck } from '@/core/fleet-check.ts';
import { raiseBudget } from '@/core/group-records.ts';
import { runHousekeeping } from '@/core/housekeeping.ts';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { runReaper } from '@/core/reaper.ts';
import { reportTransition } from '@/core/report-records.ts';
import { noteActivity } from '@/core/session-activity.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { startSession } from '@/core/session-start.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { SupervisionHalted } from '@/core/supervision-run.ts';
import { createChildTask } from '@/core/task-records.ts';
import { HivemindError } from '@/domain/errors.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { selfHostedLimits } from '@/domain/model.ts';
import {
  closedTaskGraceMs,
  fleetIntervalMs,
  housekeepingIntervalMs,
  notEnrolledMs,
  spendUnknownMs,
  startingResolveMs,
  taskWithoutSessionMs,
  waitingForPersonMs,
} from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { Platforms } from '@/ports/platform.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService } from '@/testing/boot.ts';
import type { TestDeps } from '@/testing/deps.ts';
import { checkoutGroup, note } from '@/testing/fixtures.ts';
import { simulatedAdapterName } from '@/testing/platforms.ts';

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

test('a tick stores status and usage and sums spend in one unit', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'working');
  ctx.simulated.setSessionUsage(ref, 4);
  const tick = await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(tick.ran).toBe(true);
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
  await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  const acuGroup = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const tokenGroup = await ctx.deps.store.group(workspaceId, other.group.id);

  expect(ctx.simulated.adapter.describe().usageUnit).toBe('acu');
  expect(token.adapter.describe().usageUnit).toBe('token');
  expect(acuGroup?.spend).toBe('4');
  expect(tokenGroup?.spend).toBe('1000');
});

test('a transition between ticks makes no platform call', async () => {
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

test('a dead session opens one finding and clears when it recovers', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'stopped');
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_dead')).toHaveLength(0);

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_dead')).toHaveLength(1);

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_dead')).toHaveLength(1);

  ctx.simulated.setSessionStatus(ref, 'working');
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_dead')).toHaveLength(0);
});

test('a reached budget refuses the next start', async () => {
  const ctx = await team();

  ctx.simulated.controls.setReportedUsage(100);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });

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

test('the reaper ends sessions of a task closed for 60 minutes', async () => {
  const ctx = await team();
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
  advance(ctx.deps, closedTaskGraceMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const ended = await ctx.deps.store.session(defaultWorkspaceId, started.session.id);

  expect(ended?.life).toBe('ended');
  expect(ended?.end_reason).toBe('task_closed');
  expect(await named(ctx.deps, 'session_dead')).toHaveLength(0);
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
  advance(ctx.deps, startingResolveMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const resolved = await ctx.deps.store.session(defaultWorkspaceId, pending.session.id);

  expect(resolved?.life).toBe('live');
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

test('escalate opens one finding and a second call updates the reason', async () => {
  const ctx = await team();
  const first = await escalateSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    reason: 'I am blocked on a decision.',
  });
  const second = await escalateSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    reason: 'The decision is still missing.',
  });

  expect((await named(ctx.deps, 'escalation')).map(finding => finding.id)).toEqual([first.id]);
  expect(second.reason).toBe('The decision is still missing.');
});

test('budget at 80 percent opens once and clears when the budget is raised', async () => {
  const ctx = await team();

  ctx.simulated.controls.setReportedUsage(80);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'budget_80')).toHaveLength(1);

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'budget_80')).toHaveLength(1);

  await raiseBudget(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    personId: ctx.admin.id,
    budget: '1000',
    note: 'The owner raised the budget.',
  });
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'budget_80')).toHaveLength(0);
});

test('waiting for a person opens once and clears when the status changes', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  advance(ctx.deps, waitingForPersonMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_waiting_for_person')).toHaveLength(1);

  ctx.simulated.setSessionStatus(ref, 'working');
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);
});

test('a session that has not enrolled is reported once and clears after enrollment', async () => {
  const fresh = await bootService();
  const installation = await openInstallation(fresh.deps);
  const secret = requirePresent(installation.bootstrapSecret, 'bootstrap key');
  const admin = await createFirstAdministrator(fresh.deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });

  await createOperatorKey(fresh.deps, {
    bootstrapSecret: secret,
    name: 'creator',
    role: 'creator',
    expiresAt: null,
  });

  const opened = await openGroup(fresh.deps, fresh.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: admin.id,
    ...checkoutGroup,
    connectionId: fresh.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'unenrolled',
    bodyHash: 'unenrolled',
  });

  expect(opened.outcome).toBe('live');
  advance(fresh.deps, notEnrolledMs);
  await runFleetCheck(fresh.deps, fresh.platforms, null, { workerId: 'worker' });
  expect(await named(fresh.deps, 'session_not_enrolled')).toHaveLength(1);

  await noteActivity(fresh.deps, defaultWorkspaceId, opened.session.id, false);
  advance(fresh.deps, fleetIntervalMs);
  await runFleetCheck(fresh.deps, fresh.platforms, null, { workerId: 'worker' });
  expect(await named(fresh.deps, 'session_not_enrolled')).toHaveLength(0);
});

test('a failed probe opens one finding and a later probe clears it', async () => {
  const ctx = await team();

  ctx.simulated.queueError('probe', 'auth');
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'connection_failing')).toHaveLength(1);

  advance(ctx.deps, housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'connection_failing')).toHaveLength(0);
});

test('a stale epoch cannot overwrite the observation the next worker stored', async () => {
  const ctx = await team();
  const halted = runFleetCheck(ctx.deps, ctx.platforms, null, {
    workerId: 'holder',
    halt: 'after_intent',
  }).catch(error => error);

  const error = await halted;

  expect(error).toBeInstanceOf(SupervisionHalted);
  if (!(error instanceof SupervisionHalted)) throw error;

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'next' });

  const session = requirePresent(
    await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id),
    'planner'
  );

  await expect(
    commitObservation(ctx.deps, {
      epoch: error.epoch,
      session,
      status: 'failed',
      reading: 9,
      finalReading: false,
      watch: {
        sessionId: session.id,
        workspaceId: session.workspace_id,
        badStatusStreak: 9,
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
  expect((await ctx.deps.store.session(defaultWorkspaceId, session.id))?.last_status).not.toBe(
    'failed'
  );
});

test('a role ceiling, a missing member, and a failed usage read each open once and clear', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 21);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_over_role_ceiling')).toHaveLength(1);

  ctx.simulated.setRoleCeiling('planner', 100);
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'session_over_role_ceiling')).toHaveLength(0);

  await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  advance(ctx.deps, taskWithoutSessionMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'task_without_session')).toHaveLength(1);

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'task_without_session')).toHaveLength(1);

  ctx.simulated.queueError('readUsage', 'unavailable');
  advance(ctx.deps, spendUnknownMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'spend_unknown')).toHaveLength(1);

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  expect(await named(ctx.deps, 'spend_unknown')).toHaveLength(0);
});

function advance(deps: TestDeps, ms: number): void {
  deps.clock.advance(ms);
}

async function named(deps: TestDeps, rule: string) {
  const rows = await deps.store.transact(tx => tx.listFindings(defaultWorkspaceId));

  return rows.filter(finding => finding.clearedAt === null && finding.rule === rule);
}

async function addChild(deps: TestDeps, groupId: string, plannerId: string) {
  const tasks = await deps.store.tasks(defaultWorkspaceId, groupId as never);
  const root = tasks.find(task => task.parent_id === null);

  if (root?.state === 'planned') {
    await reportTransition(deps, {
      workspaceId: defaultWorkspaceId,
      groupId: root.group_id,
      taskId: root.id,
      expectedVersion: root.version,
      actor: { kind: 'session', role: 'planner', sessionId: plannerId as never, live: true },
      to: 'analyzing',
      note,
      evidence: [],
      nextVerificationMode: null,
    });
  }

  const created = await createChildTask(deps, {
    workspaceId: defaultWorkspaceId,
    groupId: root?.group_id ?? (groupId as never),
    actor: { sessionId: plannerId as never, live: true },
    title: 'Tax interface',
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
  });

  return created.task.id;
}
