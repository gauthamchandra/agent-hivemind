import { expect, spyOn, test } from 'bun:test';
import { escalateSession } from '@/core/escalate.ts';
import { commitObservation, runFleetCheck } from '@/core/fleet-check.ts';
import { deliverFindings } from '@/core/fleet-notify.ts';
import { raiseBudget } from '@/core/group-records.ts';
import { retainClosedGroup, runHousekeeping, writeConnectionWatch } from '@/core/housekeeping.ts';
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
import { SupervisionHalted, takeJob } from '@/core/supervision-run.ts';
import { createChildTask } from '@/core/task-records.ts';
import { HivemindError } from '@/domain/errors.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { selfHostedLimits } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import {
  closedTaskGraceMs,
  emptyWatch,
  fleetDeadlineMs,
  fleetIntervalMs,
  housekeepingIntervalMs,
  leaseMs,
  notEnrolledMs,
  rateRowMaxAgeMs,
  reaperIntervalMs,
  reminderCriticalMs,
  retentionMs,
  searchWindowMs,
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

test('housekeeping drops a done intent and a cleared connection finding after a day', async () => {
  const ctx = await team();
  const old = formatTime(new Date(ctx.deps.clock.now().getTime() - rateRowMaxAgeMs - 1000));
  const now = formatTime(ctx.deps.clock.now());

  await ctx.db.query(
    `INSERT INTO job_intents (
       id, job, action, target_id, workspace_id, epoch, state, created_at, finished_at
     ) VALUES
       ('old-intent', 'fleet_check', 'observe', 'old', $1, 1, 'done', $2::timestamptz, $2::timestamptz),
       ('new-intent', 'fleet_check', 'observe', 'new', $1, 1, 'done', $3::timestamptz, $3::timestamptz)`,
    [defaultWorkspaceId, old, now]
  );
  await ctx.db.query(
    `INSERT INTO findings (
       id, workspace_id, group_id, rule, target_id, severity, reason, opened_at,
       last_seen_at, notified_at, cleared_at, notify
     ) VALUES (
       'old-connection', $1, NULL, 'connection_failing', $2, 'critical', NULL,
       $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz, false
     )`,
    [defaultWorkspaceId, ctx.connectionId, old]
  );
  await ctx.db.query(
    `INSERT INTO notification_attempts (
       id, workspace_id, delivery_id, recipient_kind, recipient_id, finding_ids,
       state, created_at, updated_at
     ) VALUES (
       'old-attempt', $1, 'old-attempt', 'administrator', $1, '["old-connection"]'::jsonb,
       'sent', $2::timestamptz, $2::timestamptz
     )`,
    [defaultWorkspaceId, old]
  );
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const intents = await ctx.deps.store.transact(tx => tx.intents('fleet_check'));
  const findings = await ctx.deps.store.transact(tx => tx.listFindings(defaultWorkspaceId));
  const attempts = await ctx.db.query(
    `SELECT id FROM notification_attempts WHERE id = 'old-attempt'`
  );

  expect(intents.some(intent => intent.id === 'old-intent')).toBe(false);
  expect(intents.some(intent => intent.id === 'new-intent')).toBe(true);
  expect(findings.some(finding => finding.id === 'old-connection')).toBe(false);
  expect(attempts.rows).toHaveLength(0);
});

test('a stale housekeeping epoch does not overwrite the watch or retain the group', async () => {
  const ctx = await team();

  ctx.simulated.queueError('probe', 'auth');

  const first = await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'holder' });

  expect(first.epoch).not.toBeNull();
  if (first.epoch === null) throw new Error('the first housekeeping run should take the lease');

  advance(ctx.deps, housekeepingIntervalMs);

  const second = await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'next' });
  const current = await ctx.deps.store.transact(tx => tx.loadFleet());
  const watch = requirePresent(
    current.connectionWatches.find(item => item.connectionId === ctx.connectionId),
    'the connection watch should exist'
  );

  expect(second.ran).toBe(true);
  expect(watch.probeFailed).toBe(false);

  await expect(
    writeConnectionWatch(ctx.deps, first.epoch, { ...watch, probeFailed: true, authFailStreak: 3 })
  ).rejects.toMatchObject({ code: 'conflict' });

  const kept = await ctx.deps.store.transact(tx => tx.loadFleet());
  const keptWatch = requirePresent(
    kept.connectionWatches.find(item => item.connectionId === ctx.connectionId),
    'the connection watch should still exist'
  );

  expect(keptWatch.probeFailed).toBe(false);
  expect(keptWatch.authFailStreak).toBe(0);

  await ctx.db.query('UPDATE groups SET closed_at = $1::timestamptz, status = $2 WHERE id = $3', [
    formatTime(new Date(ctx.deps.clock.now().getTime() - retentionMs - 1000)),
    'closed',
    ctx.opened.group.id,
  ]);

  await expect(
    retainClosedGroup(ctx.deps, first.epoch, defaultWorkspaceId, ctx.opened.group.id)
  ).rejects.toMatchObject({ code: 'conflict' });

  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(group?.id).toBe(ctx.opened.group.id);
});

test('a missing usage read leaves the final reading due, and zero clears it', async () => {
  const ctx = await team();
  const tick = await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  const session = requirePresent(
    await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id),
    'planner'
  );

  await ctx.db.query(
    'UPDATE sessions SET final_usage_pending = true, life = $2, ended_at = created_at WHERE id = $1',
    [session.id, 'ended']
  );
  session.life = 'ended';
  session.final_usage_pending = true;

  await commitObservation(ctx.deps, {
    epoch: tick.epoch ?? 0,
    session,
    status: null,
    reading: null,
    finalReading: true,
    watch: emptyWatch(session.id, session.workspace_id),
  });

  const pending = await ctx.deps.store.session(defaultWorkspaceId, session.id);

  expect(pending?.final_usage_pending).toBe(true);

  await commitObservation(ctx.deps, {
    epoch: tick.epoch ?? 0,
    session: pending ?? session,
    status: null,
    reading: 0,
    finalReading: true,
    watch: emptyWatch(session.id, session.workspace_id),
  });

  const cleared = await ctx.deps.store.session(defaultWorkspaceId, session.id);

  expect(cleared?.final_usage_pending).toBe(false);
  expect(cleared?.usage).toBe('0');
});

test('one recipient succeeding does not drop the other recipient', async () => {
  const ctx = await team();
  const finding = {
    id: ctx.deps.ids.finding(),
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    rule: 'start_unresolved' as const,
    targetId: ctx.planner.id,
    severity: 'critical' as const,
    reason: null,
    openedAt: formatTime(ctx.deps.clock.now()),
    lastSeenAt: formatTime(ctx.deps.clock.now()),
    notifiedAt: null,
    clearedAt: null,
    notify: true,
  };

  await ctx.deps.store.transact(tx => tx.insertFinding(finding));

  const epoch = await takeFleetLease(ctx.deps);
  let allowAdmin = false;
  const adminIds: string[] = [];
  const notifier = {
    async deliver(notification: { deliveryId: string; recipient: { kind: string } }) {
      if (notification.recipient.kind === 'administrator') {
        adminIds.push(notification.deliveryId);
        if (!allowAdmin) throw new Error('The administrator delivery failed.');
      }
    },
  };
  const snapshot = await ctx.deps.store.transact(tx => tx.loadFleet());

  await deliverFindings(ctx.deps, notifier, snapshot, epoch);

  const still = await ctx.deps.store.transact(tx => tx.listFindings(defaultWorkspaceId));

  expect(still.find(item => item.id === finding.id)?.notify).toBe(true);

  allowAdmin = true;
  const again = await ctx.deps.store.transact(tx => tx.loadFleet());

  await deliverFindings(ctx.deps, notifier, again, epoch);

  const done = await ctx.deps.store.transact(tx => tx.listFindings(defaultWorkspaceId));

  expect(done.find(item => item.id === finding.id)?.notify).toBe(false);
  expect(adminIds).toHaveLength(2);
  expect(adminIds[0]).toBe(adminIds[1]);
});

test('a fleet watch write does not erase the reaper fields', async () => {
  const ctx = await team();
  const base = emptyWatch(ctx.planner.id, defaultWorkspaceId);

  await ctx.deps.store.transact(async tx => {
    await tx.saveWatch({ ...base, endAttemptRuns: 7, badStatusStreak: 1 }, 'reaper');
    await tx.saveWatch({ ...base, endAttemptRuns: 0, badStatusStreak: 4 }, 'fleet');
  });

  const snapshot = await ctx.deps.store.transact(tx => tx.loadFleet());
  const watch = requirePresent(
    snapshot.watches.find(item => item.sessionId === ctx.planner.id),
    'the watch should exist'
  );

  expect(watch.endAttemptRuns).toBe(7);
  expect(watch.badStatusStreak).toBe(4);

  await ctx.deps.store.transact(tx =>
    tx.saveWatch({ ...base, endAttemptRuns: 3, badStatusStreak: 0 }, 'reaper')
  );

  const afterReaper = await ctx.deps.store.transact(tx => tx.loadFleet());
  const kept = requirePresent(
    afterReaper.watches.find(item => item.sessionId === ctx.planner.id),
    'the watch should exist'
  );

  expect(kept.endAttemptRuns).toBe(3);
  expect(kept.badStatusStreak).toBe(4);
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

  const ends = ctx.simulated.calls().filter(call => call === 'end').length;

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBe(ends);
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
        lastAttemptAt: null,
        usageGrewAt: null,
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

test('a failed read is remembered without becoming a successful reading', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 4);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });

  const before = await ctx.db.query<{ last_reading_at: string | null }>(
    'SELECT last_reading_at FROM session_watches WHERE session_id = $1',
    [ctx.planner.id]
  );
  const readingAt = before.rows[0]?.last_reading_at;

  expect(readingAt).not.toBeNull();

  advance(ctx.deps, fleetIntervalMs);

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

  await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  const after = await ctx.db.query<{
    last_reading_at: string | null;
    last_attempt_at: string | null;
  }>('SELECT last_reading_at, last_attempt_at FROM session_watches WHERE session_id = $1', [
    ctx.planner.id,
  ]);

  expect(after.rows[0]?.last_reading_at).toEqual(readingAt);
  expect(after.rows[0]?.last_attempt_at).not.toBeNull();
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

  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });

  const recent = formatTime(ctx.deps.clock.now());
  const older = formatTime(new Date(ctx.deps.clock.now().getTime() - 60_000));

  await ctx.db.query(
    `UPDATE session_watches
     SET last_observed_at = $2::timestamptz, last_attempt_at = $3::timestamptz
     WHERE session_id = $1`,
    [ctx.planner.id, older, recent]
  );
  await ctx.db.query(
    `UPDATE session_watches
     SET last_observed_at = $2::timestamptz, last_attempt_at = $3::timestamptz
     WHERE session_id = $1`,
    [started.session.id, recent, older]
  );
  advance(ctx.deps, fleetIntervalMs);

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

  await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  const plannerRef = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const implementerRef = requirePresent(started.session.platform_session_ref, 'implementer ref');

  expect(order).toContain(implementerRef);
  expect(order).toContain(plannerRef);
  expect(order.indexOf(implementerRef)).toBeLessThan(order.indexOf(plannerRef));
});

test('recovered usage growth keeps a quiet task from looking stalled', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  advance(ctx.deps, 7 * 60 * 60 * 1000);
  await expect(
    runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker', halt: 'after_intent' })
  ).rejects.toBeInstanceOf(SupervisionHalted);

  ctx.simulated.setSessionUsage(ref, 10);
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });

  expect(await named(ctx.deps, 'task_stalled')).toHaveLength(0);

  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });

  expect(await named(ctx.deps, 'task_stalled')).toHaveLength(0);
});

test('retention waits while a final reading is still pending', async () => {
  const ctx = await team();
  const closedAt = formatTime(new Date(ctx.deps.clock.now().getTime() - retentionMs - 1000));

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await ctx.db.query('UPDATE groups SET status = $2, closed_at = $3::timestamptz WHERE id = $1', [
    ctx.opened.group.id,
    'closed',
    closedAt,
  ]);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();

  await ctx.db.query('UPDATE sessions SET final_usage_pending = false WHERE id = $1', [
    ctx.planner.id,
  ]);
  advance(ctx.deps, housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
});

test('a slow workspace does not keep the next workspace from being read', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'A second session in the first workspace.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'slow-workspace',
    bodyHash: 'slow-workspace',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');

  const otherId = ctx.deps.ids.workspace();
  const personId = ctx.deps.ids.person();
  const connectionId = ctx.deps.ids.connection();
  const otherPlatform = createSimulatedPlatform(connectionId);
  const now = formatTime(ctx.deps.clock.now());

  await ctx.deps.store.transact(async tx => {
    await tx.insertWorkspace({
      id: otherId,
      name: 'Second',
      status: 'active',
      limits: selfHostedLimits,
      created_at: now,
    });
    await tx.insertPerson({
      id: personId,
      workspace_id: otherId,
      display_name: 'Grace',
      workspace_role: 'administrator',
      account_id: null,
      status: 'active',
      created_at: now,
    });
  });
  await ctx.deps.store.saveConnection({
    workspaceId: otherId,
    id: connectionId,
    adapter: simulatedAdapterName,
    createdAt: now,
  });

  const platforms: Platforms = {
    require(id) {
      if (id === ctx.connectionId) {
        return { adapter: ctx.simulated.adapter, connection: ctx.simulated.connection() };
      }
      if (id === connectionId) {
        return { adapter: otherPlatform.adapter, connection: otherPlatform.connection() };
      }

      throw new HivemindError('not_found', 'No connection with that identifier exists.');
    },
  };
  const other = await openGroup(ctx.deps, platforms, {
    workspaceId: otherId,
    personId,
    name: 'Second',
    goal: 'A second workspace that must still be read.',
    budget: '100',
    connectionId,
    verificationMode: 'before_merge',
    notes: [],
    instructions: 'Plan the second workspace.',
    idempotencyKey: 'second-workspace',
    bodyHash: 'second-workspace',
  });

  expect(other.outcome).toBe('live');
  if (other.outcome !== 'live') throw new Error('the second planner did not start');

  const seen: string[] = [];
  const reading: Platforms = {
    require(id) {
      const handle = platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async (connection, ref) => {
            seen.push(ref);
            ctx.deps.clock.advance(fleetDeadlineMs / 2 + 1000);

            return handle.adapter.readStatus(connection, ref);
          },
        },
      };
    },
  };

  await runFleetCheck(ctx.deps, reading, null, { workerId: 'worker' });

  const otherRef = requirePresent(other.session.platform_session_ref, 'second planner ref');

  expect(seen).toContain(otherRef);
});

test('an observation that does not fit the deadline stays open', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'This observation should wait.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'wait-observation',
    bodyHash: 'wait-observation',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');
  if (started.outcome !== 'live') throw new Error('implementer did not start');

  const now = formatTime(ctx.deps.clock.now());

  await ctx.db.query(
    `INSERT INTO job_intents (
       id, job, action, target_id, workspace_id, epoch, state, created_at
     ) VALUES
       ('slow-intent', 'fleet_check', 'observe', $1, $2, 1, 'open', $3::timestamptz),
       ('later-intent', 'fleet_check', 'observe', $4, $2, 1, 'open', $5::timestamptz)`,
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
            if (ref === plannerRef) ctx.deps.clock.advance(fleetDeadlineMs + 1000);

            return handle.adapter.readStatus(connection, ref);
          },
        },
      };
    },
  };

  await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  const intents = await ctx.deps.store.transact(tx => tx.intents('fleet_check'));
  const implementerRef = requirePresent(started.session.platform_session_ref, 'implementer ref');

  expect(seen.filter(ref => ref === plannerRef)).toHaveLength(1);
  expect(seen).not.toContain(implementerRef);
  expect(intents.find(intent => intent.id === 'later-intent')?.state).toBe('open');
});

test('an authentication failure does not open a status finding', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });
  advance(ctx.deps, waitingForPersonMs + fleetIntervalMs);

  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async () => {
            throw new PlatformError('auth', 'The credential was rejected.');
          },
        },
      };
    },
  };

  await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  expect(await named(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);
});

function takeFleetLease(deps: TestDeps): Promise<number> {
  return takeJob(deps, 'fleet_check', 'worker', fleetIntervalMs).then(epoch => {
    if (epoch === null) throw new Error('the fleet check lease should be free');

    return epoch;
  });
}

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

test('escalate locks workspace, then group, then the task, then the session', async () => {
  const ctx = await team();
  const order: string[] = [];
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const watched = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);

          if (typeof value !== 'function') return value;
          if (typeof prop !== 'string' || !prop.startsWith('lock')) return value.bind(target);

          return (...args: unknown[]) => {
            order.push(prop);

            return value.apply(target, args);
          };
        },
      });

      return work(watched);
    });

  await escalateSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    reason: 'Need a person.',
  });

  expect(order.slice(0, 5)).toEqual([
    'lockWorkspace',
    'lockGroup',
    'lockTask',
    'lockTask',
    'lockSession',
  ]);
});

test('a read longer than the lease still records spend and the finding', async () => {
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
            ctx.deps.clock.advance(leaseMs + 1000);

            return handle.adapter.readStatus(connection, sessionRef);
          },
        },
      };
    },
  };

  const tick = await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  expect(tick.ran).toBe(true);
  expect((await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id))?.spend).toBe('100');
  expect(await named(ctx.deps, 'budget_reached')).toHaveLength(1);
});

test('a stale reaper epoch does not save the watch', async () => {
  const ctx = await team();
  const watch = emptyWatch(ctx.planner.id, defaultWorkspaceId);

  watch.endAttemptRuns = 4;
  watch.lastFind = 'absent';
  watch.inconclusiveRuns = 2;
  watch.suspendedProgressAt = formatTime(ctx.deps.clock.now());

  await expect(writeReaperWatch(ctx.deps, 1, watch)).rejects.toMatchObject({ code: 'conflict' });

  const snapshot = await ctx.deps.store.transact(tx => tx.loadFleet());

  expect(snapshot.watches.find(item => item.sessionId === ctx.planner.id)).toBeUndefined();
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

test('one bad open observation does not stop the rest of the tick', async () => {
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

  const first = await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  expect(first.ran).toBe(true);

  advance(ctx.deps, fleetIntervalMs);

  const second = await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });
  const implementer = await ctx.deps.store.session(defaultWorkspaceId, started.session.id);

  expect(second.ran).toBe(true);
  expect(implementer?.last_status).not.toBeNull();
  expect(errors.mock.calls.some(call => String(call[0]).includes(ctx.planner.id))).toBe(true);
  expect(errors.mock.calls.some(call => call[1] instanceof Error)).toBe(true);

  errors.mockRestore();
});

test('a reminder uses a new delivery id', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');
  const ids: string[] = [];
  const notifier = {
    async deliver(notification: { deliveryId: string }) {
      ids.push(notification.deliveryId);
    },
  };

  ctx.simulated.setSessionStatus(ref, 'stopped');
  await runFleetCheck(ctx.deps, ctx.platforms, notifier, { workerId: 'worker' });
  advance(ctx.deps, fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, notifier, { workerId: 'worker' });

  expect(ids).toHaveLength(1);

  advance(ctx.deps, reminderCriticalMs + fleetIntervalMs);
  await runFleetCheck(ctx.deps, ctx.platforms, notifier, { workerId: 'worker' });

  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test('an unreliable connection is not read again for the next session', async () => {
  const ctx = await team();
  const child = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId: child,
    role: 'implementer',
    instructions: 'Second session on the same connection.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'same-connection',
    bodyHash: 'same-connection',
    replacementOf: null,
  });

  let reads = 0;
  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          readStatus: async () => {
            reads += 1;

            throw new PlatformError('unavailable', 'The platform did not answer.');
          },
        },
      };
    },
  };

  await runFleetCheck(ctx.deps, platforms, null, { workerId: 'worker' });

  expect(reads).toBe(1);
});

test('a failed platform stop counts as an end attempt', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true,
         platform_stop_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  ctx.simulated.queueError('end', 'unavailable');
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const snapshot = await ctx.deps.store.transact(tx => tx.loadFleet());
  const watch = requirePresent(
    snapshot.watches.find(item => item.sessionId === ctx.planner.id),
    'the end attempt should be recorded'
  );

  expect(watch.endAttemptRuns).toBe(1);
});

test('a probe that throws still deletes an expired code', async () => {
  const ctx = await team();
  const expired = formatTime(new Date(ctx.deps.clock.now().getTime() - 60_000));

  await ctx.db.query(
    `INSERT INTO enrollment_codes (
       id, workspace_id, session_id, code_hash, expires_at, attempts, created_at
     ) VALUES ('code-expired', $1, $2, 'hash-expired', $3::timestamptz, 0, $3::timestamptz)`,
    [defaultWorkspaceId, ctx.planner.id, expired]
  );

  const platforms: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          probe: async () => {
            throw new Error('The adapter is missing.');
          },
        },
      };
    },
  };

  await runHousekeeping(ctx.deps, platforms, { workerId: 'worker' });

  const codes = await ctx.db.query<{ id: string }>('SELECT id FROM enrollment_codes');
  const snapshot = await ctx.deps.store.transact(tx => tx.loadFleet());
  const watch = requirePresent(
    snapshot.connectionWatches.find(item => item.connectionId === ctx.connectionId),
    'the probe failure should be recorded'
  );

  expect(codes.rows).toHaveLength(0);
  expect(watch.probeFailed).toBe(true);
});

test('a usage reading does not clear an unfinished platform stop', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 0);
  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true,
         platform_stop_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await runFleetCheck(ctx.deps, ctx.platforms, null, { workerId: 'worker' });

  const read = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(read?.final_usage_pending).toBe(false);
  expect(read?.usage).toBe('0');
  expect(read?.platform_stop_pending).toBe(true);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(0);

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stopped = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(stopped?.platform_stop_pending).toBe(false);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(1);
});

test('a pending stop of an ended session is finished, and a finished one is left', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

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

  const ends = ctx.simulated.calls().filter(call => call === 'end').length;

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'end').length).toBe(ends);
  expect(ref).not.toBe('');
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

  const finds = ctx.simulated.calls().filter(call => call === 'find').length;

  advance(ctx.deps, reaperIntervalMs);
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(ctx.simulated.calls().filter(call => call === 'find').length).toBe(finds);
});
