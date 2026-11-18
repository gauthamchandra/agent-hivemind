import { expect, spyOn, test } from 'bun:test';
import { syncAlerts } from '@/core/alert-sync.ts';
import { drainOutbox } from '@/core/delivery.ts';
import { escalateSession } from '@/core/escalate.ts';
import { raiseBudget } from '@/core/group-records.ts';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { takeJob } from '@/core/job-run.ts';
import { runReaper } from '@/core/reaper.ts';
import { sendMessage } from '@/core/send-message.ts';
import { noteActivity } from '@/core/session-activity.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { startSession } from '@/core/session-start.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { runUsagePoll } from '@/core/usage-poll.ts';
import type { AlertRule } from '@/domain/background-jobs.ts';
import {
  notEnrolledMs,
  spendUnknownMs,
  taskWithoutSessionMs,
  usagePollIntervalMs,
  waitingForPersonMs,
} from '@/domain/background-jobs.ts';
import { defaultWorkspaceId, type MessageId } from '@/domain/ids.ts';
import { maxWaitSeconds } from '@/domain/message.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { PlatformError } from '@/domain/platform.ts';
import type { PlatformAdapter, Platforms } from '@/ports/platform.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService } from '@/testing/boot.ts';
import type { TestDeps } from '@/testing/deps.ts';
import { checkoutGroup } from '@/testing/fixtures.ts';
import { addChild, team } from '@/testing/team.ts';
import { runAfterTest } from '@/testing/teardown.ts';

type Ctx = Awaited<ReturnType<typeof team>>;

test('a dead session opens one alert and clears when it recovers', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'stopped');
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(0);

  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const opened = await openAlerts(ctx.deps, 'session_dead');

  expect(opened).toHaveLength(1);

  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const kept = await openAlerts(ctx.deps, 'session_dead');

  expect(kept.map(alert => alert.id)).toEqual(opened.map(alert => alert.id));
  expect(kept[0]?.lastSeenAt).not.toBe(opened[0]?.lastSeenAt);

  ctx.simulated.setSessionStatus(ref, 'working');
  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(0);
});

test('budget at 80 percent opens once and clears when the budget is raised', async () => {
  const ctx = await team();

  ctx.simulated.controls.setReportedUsage(80);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(1);

  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(1);

  await raiseBudget(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    personId: ctx.admin.id,
    budget: '1000',
    note: 'The owner raised the budget.',
  });
  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(0);
});

test('waiting for a person opens once and clears when the status changes', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  advance(ctx.deps, waitingForPersonMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(1);

  ctx.simulated.setSessionStatus(ref, 'working');
  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);
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
  if (opened.outcome !== 'live') throw new Error('planner did not start');

  advance(fresh.deps, notEnrolledMs);
  await runUsagePoll(fresh.deps, fresh.platforms, { workerId: 'worker' });
  expect(await openAlerts(fresh.deps, 'session_not_enrolled')).toHaveLength(1);

  await noteActivity(fresh.deps, defaultWorkspaceId, opened.session.id, false);
  advance(fresh.deps, usagePollIntervalMs);
  await runUsagePoll(fresh.deps, fresh.platforms, { workerId: 'worker' });
  expect(await openAlerts(fresh.deps, 'session_not_enrolled')).toHaveLength(0);
});

test('a role ceiling, a missing member, and a failed usage read each open once and clear', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionUsage(ref, 21);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'session_over_role_ceiling')).toHaveLength(1);

  ctx.simulated.setRoleCeiling('planner', 100);
  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'session_over_role_ceiling')).toHaveLength(0);

  await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  advance(ctx.deps, taskWithoutSessionMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'task_without_session')).toHaveLength(1);

  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'task_without_session')).toHaveLength(1);

  ctx.simulated.queueError('readUsage', 'unavailable');
  advance(ctx.deps, spendUnknownMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'spend_unknown')).toHaveLength(1);

  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'spend_unknown')).toHaveLength(0);
});

test('recovered usage growth keeps a quiet task from looking stalled', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  advance(ctx.deps, 7 * 60 * 60 * 1000);
  await expect(
    runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker', crashAt: 'after_planned_action' })
  ).rejects.toBeInstanceOf(StoppedProcess);

  ctx.simulated.setSessionUsage(ref, 10);
  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await openAlerts(ctx.deps, 'task_stalled')).toHaveLength(0);

  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await openAlerts(ctx.deps, 'task_stalled')).toHaveLength(0);
});

test('an authentication failure does not open an alert that needs the status', async () => {
  const ctx = await team();
  const ref = requirePresent(ctx.planner.platform_session_ref, 'planner ref');

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  advance(ctx.deps, waitingForPersonMs + usagePollIntervalMs);

  const platforms = platformsFailingStatusRead(ctx);

  await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });

  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);
});

test('an escalation stays open while its session lives and clears when it ends', async () => {
  const ctx = await team();

  await escalateSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    reason: 'I am blocked on a decision.',
  });
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'escalation')).toHaveLength(1);

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'service' },
    reason: 'The planner is done.',
  });
  advance(ctx.deps, usagePollIntervalMs);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'escalation')).toHaveLength(0);
});

test('a worker with an old lock id writes no alert', async () => {
  const ctx = await team();
  const lockId = requirePresent(
    await takeJob(ctx.deps, 'usage_poll', 'worker', usagePollIntervalMs),
    'the job lock should be free'
  );

  await ctx.db.query(`UPDATE groups SET spend = '90' WHERE id = $1`, [ctx.opened.group.id]);

  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  await expect(
    syncAlerts(ctx.deps, ctx.platforms, snapshot, lockId + 1, {
      unreliableConnections: new Set(),
      tasksWithUsageGrowth: new Set(),
    })
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(0);

  await syncAlerts(ctx.deps, ctx.platforms, snapshot, lockId, {
    unreliableConnections: new Set(),
    tasksWithUsageGrowth: new Set(),
  });
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(1);

  await ctx.db.query(`UPDATE groups SET spend = '0' WHERE id = $1`, [ctx.opened.group.id]);

  const opened = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  await expect(
    syncAlerts(ctx.deps, ctx.platforms, opened, lockId + 1, {
      unreliableConnections: new Set(),
      tasksWithUsageGrowth: new Set(),
    })
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(1);
});

test('a cleared alert opens again as a new row when the condition returns', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setSessionStatus(ref, 'failed');
  await poll(ctx, 2);
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(1);

  ctx.simulated.setSessionStatus(ref, 'working');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(0);

  ctx.simulated.setSessionStatus(ref, 'failed');
  await poll(ctx, 2);
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(1);
  expect(await alertRowCount(ctx, 'session_dead')).toBe(2);
});

test('one bad reading, or bad readings with a good one between, opens no dead-session alert', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setSessionStatus(ref, 'unknown');
  await poll(ctx);
  ctx.simulated.setSessionStatus(ref, 'working');
  await poll(ctx);
  ctx.simulated.setSessionStatus(ref, 'stopped');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(0);

  ctx.simulated.setSessionStatus(ref, 'unknown');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(1);
});

test('a failed read leaves an open alert open until a read succeeds', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await poll(ctx);
  advance(ctx.deps, waitingForPersonMs);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(1);

  await closeTasksOfGroup(ctx);
  await poll(ctx, 1, platformsFailingStatusRead(ctx));
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(1);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);
});

test('waiting for a person is timed from the latest change of status', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await poll(ctx);
  ctx.simulated.setSessionStatus(ref, 'working');
  await poll(ctx);
  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);

  advance(ctx.deps, waitingForPersonMs);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(1);
});

test('budget alerts open at 80 percent and when the budget is reached, and not before', async () => {
  const ctx = await team();
  const expectOpen = async (spend: string, budget80: number, reached: number) => {
    await ctx.db.query(`UPDATE groups SET spend = $2 WHERE id = $1`, [ctx.opened.group.id, spend]);
    await poll(ctx);
    expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(budget80);
    expect(await openAlerts(ctx.deps, 'budget_reached')).toHaveLength(reached);
  };

  await expectOpen('79.99', 0, 0);
  await expectOpen('80', 1, 0);
  await expectOpen('99.99', 1, 0);
  await expectOpen('100', 1, 1);
});

test('a task with no activity for hours is reported and clears when its session spends again', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  advance(ctx.deps, 5 * 60 * 60 * 1000);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'task_stalled')).toHaveLength(0);

  advance(ctx.deps, 2 * 60 * 60 * 1000);
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker' });
  expect(await openAlerts(ctx.deps, 'task_stalled')).toHaveLength(1);

  ctx.simulated.setSessionUsage(ref, 3);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'task_stalled')).toHaveLength(0);
});

test('a closed task raises no alert about its waiting, dead, or unenrolled session', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await poll(ctx);
  await closeTasksOfGroup(ctx);
  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  advance(ctx.deps, waitingForPersonMs);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);

  ctx.simulated.setSessionStatus(ref, 'stopped');
  await poll(ctx, 2);
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(0);

  await ctx.db.query(`UPDATE sessions SET enrolled_at = NULL WHERE id = $1`, [ctx.planner.id]);
  advance(ctx.deps, notEnrolledMs);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_not_enrolled')).toHaveLength(0);
});

test('an ended session raises no role ceiling alert', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setSessionUsage(ref, 25);
  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, final_usage_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await poll(ctx);

  expect(await openAlerts(ctx.deps, 'session_over_role_ceiling')).toHaveLength(0);
});

test('a role ceiling the platform leaves unbounded does not stop the other alerts', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);

  ctx.simulated.setRoleCeiling('planner', Number.POSITIVE_INFINITY);
  ctx.simulated.setSessionUsage(ref, 90);
  await poll(ctx);

  expect(await openAlerts(ctx.deps, 'session_over_role_ceiling')).toHaveLength(0);
  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(1);
});

test('a group with no session the platform can read does not report unknown spend', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'start_failed', ended_at = created_at, platform_session_ref = NULL,
         token_hash = NULL, final_usage_pending = false
     WHERE id = $1`,
    [ctx.planner.id]
  );
  advance(ctx.deps, spendUnknownMs);
  await poll(ctx);

  expect(await openAlerts(ctx.deps, 'spend_unknown')).toHaveLength(0);
});

test('a connection that cannot be described is logged and keeps its ceiling alert open', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

  runAfterTest(() => warn.mockRestore());
  ctx.simulated.setSessionUsage(ref, 25);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_over_role_ceiling')).toHaveLength(1);

  const undescribable: Platforms = {
    require(id) {
      const handle = ctx.platforms.require(id);

      return {
        connection: handle.connection,
        adapter: {
          ...handle.adapter,
          describe: () => {
            throw new Error('The adapter cannot be described.');
          },
        },
      };
    },
  };

  await poll(ctx, 1, undescribable);

  expect(await openAlerts(ctx.deps, 'session_over_role_ceiling')).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain(ctx.connectionId);
});

test('an open alert of a rule this release does not know is left open and does not stop the poll', async () => {
  const ctx = await team();

  await ctx.db.query(
    `INSERT INTO alerts (id, workspace_id, rule, target_id, severity, opened_at, last_seen_at)
     VALUES ('alr_future', $1, 'a_rule_from_a_newer_release', 'ses_future', 'normal', now(), now())`,
    [defaultWorkspaceId]
  );
  ctx.simulated.setSessionStatus(plannerRef(ctx), 'stopped');
  await poll(ctx, 2);

  const future = await ctx.db.query<{ cleared_at: string | null }>(
    `SELECT cleared_at FROM alerts WHERE id = 'alr_future'`
  );

  expect(future.rows[0]?.cleared_at).toBeNull();
  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(1);
});

test('a session idle on the task it should be working for an hour opens an alert and clears when the task moves on', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);

  ctx.simulated.setSessionStatus(refOf(implementer), 'idle');
  await poll(ctx, 12);
  expect(await openAlerts(ctx.deps, 'session_idle_on_open_task')).toHaveLength(0);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_idle_on_open_task')).toHaveLength(1);

  await ctx.db.query(`UPDATE tasks SET state = 'in_review' WHERE id = $1`, [implementer.task_id]);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_idle_on_open_task')).toHaveLength(0);
});

test('a session waiting for an answer is not reported idle until the answer comes', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);
  const question = await ask(ctx, implementer, ctx.planner, 'ask-1', maxWaitSeconds);

  ctx.simulated.setSessionStatus(refOf(implementer), 'suspended');
  await poll(ctx, 14);
  expect(await openAlerts(ctx.deps, 'session_idle_on_open_task')).toHaveLength(0);

  await answer(ctx, ctx.planner, implementer, question.message.id, 'answer-1');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'session_idle_on_open_task')).toHaveLength(1);
});

test('an ended session not confirmed stopped after three runs opens an alert and clears once it stops', async () => {
  const ctx = await team();

  await ctx.db.query(`UPDATE sessions SET life = 'ended', ended_at = created_at WHERE id = $1`, [
    ctx.planner.id,
  ]);
  await rememberAboutSession(ctx, ctx.planner.id, { endUnconfirmedRuns: 2 });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'end_not_confirmed')).toHaveLength(0);

  await rememberAboutSession(ctx, ctx.planner.id, { endUnconfirmedRuns: 3 });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'end_not_confirmed')).toHaveLength(1);

  ctx.simulated.setSessionStatus(plannerRef(ctx), 'stopped');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'end_not_confirmed')).toHaveLength(0);
});

test('an end request still unsettled after six attempts opens an alert and clears once the session ends', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions SET end_requested_at = created_at, end_actor_kind = 'service' WHERE id = $1`,
    [ctx.planner.id]
  );
  await rememberAboutSession(ctx, ctx.planner.id, { endAttemptRuns: 5 });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'end_pending')).toHaveLength(0);

  await rememberAboutSession(ctx, ctx.planner.id, { endAttemptRuns: 6 });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'end_pending')).toHaveLength(1);

  await ctx.db.query(`UPDATE sessions SET life = 'ended', ended_at = created_at WHERE id = $1`, [
    ctx.planner.id,
  ]);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'end_pending')).toHaveLength(0);
});

test('a start the platform could not settle in six runs opens an alert and clears once the session is live', async () => {
  const ctx = await team();

  await ctx.db.query(`UPDATE sessions SET life = 'starting' WHERE id = $1`, [ctx.planner.id]);
  await rememberAboutSession(ctx, ctx.planner.id, {
    inconclusiveRuns: 5,
    lastFind: 'inconclusive',
  });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(0);

  await rememberAboutSession(ctx, ctx.planner.id, {
    inconclusiveRuns: 6,
    lastFind: 'inconclusive',
  });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(1);

  await ctx.db.query(`UPDATE sessions SET life = 'live' WHERE id = $1`, [ctx.planner.id]);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(0);
});

test('a start the platform has no record of opens an alert once the session shows signs of life or a day has passed', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions SET life = 'starting', existence_evidence_at = NULL WHERE id = $1`,
    [ctx.planner.id]
  );
  await rememberAboutSession(ctx, ctx.planner.id, { lastFind: 'absent' });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(0);

  await ctx.db.query(`UPDATE sessions SET existence_evidence_at = $2 WHERE id = $1`, [
    ctx.planner.id,
    ctx.deps.clock.now().toISOString(),
  ]);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(1);

  await ctx.db.query(`UPDATE sessions SET existence_evidence_at = NULL WHERE id = $1`, [
    ctx.planner.id,
  ]);
  await rememberAboutSession(ctx, ctx.planner.id, { lastFind: 'found' });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(0);

  await rememberAboutSession(ctx, ctx.planner.id, { lastFind: 'absent' });
  advance(ctx.deps, 23 * hourMs + 35 * minuteMs);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(0);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'start_unresolved')).toHaveLength(1);
});

test('an orphan platform session the reaper ended opens an alert while the group is open and clears when it closes', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'start_failed', platform_session_ref = NULL, platform_address = NULL,
         token_hash = NULL, ended_at = created_at, final_usage_pending = false,
         platform_stop_pending = false
     WHERE id = $1`,
    [implementer.id]
  );
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const settled = await ctx.deps.store.session(defaultWorkspaceId, implementer.id);

  expect(settled?.platform_session_ref).not.toBeNull();
  expect(settled?.platform_stop_pending).toBe(false);
  expect(settled?.final_usage_pending).toBe(false);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'orphan_platform_session_ended')).toHaveLength(1);

  await ctx.db.query(`UPDATE groups SET status = 'closed', closed_at = created_at WHERE id = $1`, [
    ctx.opened.group.id,
  ]);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'orphan_platform_session_ended')).toHaveLength(0);
});

test('an end request on a released session still unsettled after six attempts opens an alert', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'released', end_requested_at = created_at, end_actor_kind = 'service'
     WHERE id = $1`,
    [ctx.planner.id]
  );
  await rememberAboutSession(ctx, ctx.planner.id, { endAttemptRuns: 6 });
  await poll(ctx);

  expect(await openAlerts(ctx.deps, 'end_pending')).toHaveLength(1);
});

test('a session that ends while its status is being read raises no dead-session alert', async () => {
  const ctx = await team();

  ctx.simulated.setSessionStatus(
    requirePresent(ctx.planner.platform_session_ref, 'planner ref'),
    'stopped'
  );
  await poll(ctx);

  const platforms = platformsWith(ctx, {
    readStatus: async (connection, ref) => {
      await ctx.db.query(
        `UPDATE sessions SET life = 'ended', ended_at = created_at, token_hash = NULL WHERE id = $1`,
        [ctx.planner.id]
      );

      return ctx.simulated.adapter.readStatus(connection, ref);
    },
  });

  await poll(ctx, 1, platforms);

  expect(await openAlerts(ctx.deps, 'session_dead')).toHaveLength(0);
});

test('a budget raised while a usage reading is taken raises no budget alert', async () => {
  const ctx = await team();
  const platforms = platformsWith(ctx, {
    readUsage: async () => {
      await ctx.db.query('UPDATE groups SET budget = 1000 WHERE id = $1', [ctx.opened.group.id]);

      return 200;
    },
  });

  await poll(ctx, 1, platforms);

  expect(await openAlerts(ctx.deps, 'budget_80')).toHaveLength(0);
  expect(await openAlerts(ctx.deps, 'budget_reached')).toHaveLength(0);
});

test('a rejected usage reading does not count as a fresh reading when spend is judged unknown', async () => {
  const ctx = await team();
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());
  await poll(ctx);
  advance(ctx.deps, spendUnknownMs);
  await poll(ctx, 1, platformsWith(ctx, { readUsage: async () => Number.NaN }));

  expect(await openAlerts(ctx.deps, 'spend_unknown')).toHaveLength(1);
});

test('a rejected usage reading does not lose the status read with it', async () => {
  const ctx = await team();
  const ref = plannerRef(ctx);
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());
  ctx.simulated.setSessionStatus(ref, 'waiting_for_person');
  await poll(ctx);
  ctx.simulated.setSessionStatus(ref, 'working');
  advance(ctx.deps, waitingForPersonMs);
  await poll(ctx, 1, platformsWith(ctx, { readUsage: async () => Number.NaN }));

  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(stored?.last_status).toBe('working');
  expect(await openAlerts(ctx.deps, 'session_waiting_for_person')).toHaveLength(0);
  expect(errors.mock.calls.some(call => call[1] instanceof Error)).toBe(true);
});

test('a wait past its deadline opens an alert and clears when the waiting session reports progress', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);

  await ask(ctx, ctx.planner, implementer, 'ask-1', 10 * 60);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_expired')).toHaveLength(0);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_expired')).toHaveLength(1);

  advance(ctx.deps, minuteMs);
  await noteActivity(ctx.deps, defaultWorkspaceId, ctx.planner.id, true);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_expired')).toHaveLength(0);
});

test('a wait 30 minutes past its deadline opens a second alert and both clear when it is answered', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);
  const question = await ask(ctx, ctx.planner, implementer, 'ask-1', 5 * 60);

  await poll(ctx, 6);
  expect(await openAlerts(ctx.deps, 'wait_expired')).toHaveLength(1);
  expect(await openAlerts(ctx.deps, 'wait_overdue')).toHaveLength(0);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_overdue')).toHaveLength(1);

  await answer(ctx, implementer, ctx.planner, question.message.id, 'answer-1');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_expired')).toHaveLength(0);
  expect(await openAlerts(ctx.deps, 'wait_overdue')).toHaveLength(0);
});

test('two sessions waiting on each other open one cycle alert that clears when one is answered', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);
  const plannersQuestion = await ask(ctx, ctx.planner, implementer, 'ask-1', maxWaitSeconds);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_cycle')).toHaveLength(0);

  await ask(ctx, implementer, ctx.planner, 'ask-2', maxWaitSeconds);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_cycle')).toHaveLength(1);

  await answer(ctx, implementer, ctx.planner, plannersQuestion.message.id, 'answer-1');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'wait_cycle')).toHaveLength(0);
});

test('a root whose children all finished without a failure raises no alert', async () => {
  const ctx = await team();
  const firstChildId = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const secondChildId = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  await closeTask(ctx, firstChildId, 'done');
  await closeTask(ctx, secondChildId, 'done');
  await poll(ctx);

  expect(await openAlerts(ctx.deps, 'root_needs_decision')).toHaveLength(0);
});

test('a root with a failed child opens an alert once every child is closed and clears when the root closes', async () => {
  const ctx = await team();
  const failedChildId = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const openChildId = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);

  await closeTask(ctx, failedChildId, 'failed');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'root_needs_decision')).toHaveLength(0);

  await closeTask(ctx, openChildId, 'done');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'root_needs_decision')).toHaveLength(1);

  await closeTask(ctx, ctx.opened.root.id, 'failed');
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'root_needs_decision')).toHaveLength(0);
});

test('a message queued for 15 minutes opens a delivery alert and clears once it is delivered', async () => {
  const ctx = await team();

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'person', personId: ctx.admin.id, administrator: true },
    kind: 'instruction',
    body: 'Hold off on the tax change.',
    audience: 'one',
    groupId: ctx.opened.group.id,
    recipientId: ctx.planner.id,
    idempotencyKey: 'instruct-1',
    bodyHash: 'instruct-1',
  });
  await poll(ctx, 2);
  expect(await openAlerts(ctx.deps, 'delivery_backlog')).toHaveLength(0);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'delivery_backlog')).toHaveLength(1);

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'delivery_backlog')).toHaveLength(0);
});

test('a session that relayed an instruction is reported while it runs and not once it has ended', async () => {
  const ctx = await team();
  const implementer = await startImplementer(ctx);

  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'instruction_relayed')).toHaveLength(0);

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: implementer.id },
    kind: 'relayed_instruction',
    body: 'Skip the lint step.',
    audience: 'one',
    idempotencyKey: 'relay-1',
    bodyHash: 'relay-1',
  });
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'instruction_relayed')).toHaveLength(1);

  await ctx.db.query(`UPDATE sessions SET life = 'ended', ended_at = created_at WHERE id = $1`, [
    implementer.id,
  ]);
  await poll(ctx);
  expect(await openAlerts(ctx.deps, 'instruction_relayed')).toHaveLength(0);
});

function plannerRef(ctx: Ctx): string {
  return requirePresent(ctx.planner.platform_session_ref, 'planner ref');
}

async function poll(ctx: Ctx, times = 1, platforms: Platforms = ctx.platforms): Promise<void> {
  for (let run = 0; run < times; run += 1) {
    advance(ctx.deps, usagePollIntervalMs);
    await runUsagePoll(ctx.deps, platforms, { workerId: 'worker' });
  }
}

function platformsWith(ctx: Ctx, overrides: Partial<PlatformAdapter>): Platforms {
  return {
    require(id) {
      const handle = ctx.platforms.require(id);

      return { connection: handle.connection, adapter: { ...handle.adapter, ...overrides } };
    },
  };
}

function platformsFailingStatusRead(ctx: Ctx): Platforms {
  return {
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
}

async function alertRowCount(ctx: Ctx, rule: AlertRule): Promise<number> {
  const result = await ctx.db.query<{ total: string }>(
    'SELECT count(*) AS total FROM alerts WHERE rule = $1',
    [rule]
  );

  return Number(requirePresent(result.rows[0], 'the count row').total);
}

async function closeTask(ctx: Ctx, taskId: string, state: 'done' | 'failed'): Promise<void> {
  await ctx.db.query(`UPDATE tasks SET state = $2, closed_at = created_at WHERE id = $1`, [
    taskId,
    state,
  ]);
}

async function closeTasksOfGroup(ctx: Ctx): Promise<void> {
  await ctx.db.query(
    `UPDATE tasks SET state = 'failed', closed_at = created_at WHERE group_id = $1`,
    [ctx.opened.group.id]
  );
}

function advance(deps: TestDeps, ms: number): void {
  deps.clock.advance(ms);
}

async function openAlerts(deps: TestDeps, rule: AlertRule) {
  const snapshot = await deps.store.transact(tx => tx.loadJobSnapshot());

  return snapshot.alerts.filter(alert => alert.rule === rule);
}

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;

function refOf(session: SessionRecord): string {
  return requirePresent(session.platform_session_ref, 'session ref');
}

async function startImplementer(ctx: Ctx): Promise<SessionRecord> {
  const taskId = await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    taskId,
    role: 'implementer',
    instructions: 'Implement the tax change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'start-implementer',
    bodyHash: 'start-implementer',
    replacementOf: null,
  });

  if (started.outcome !== 'live') throw new Error('The implementer did not start.');

  return started.session;
}

function ask(
  ctx: Ctx,
  sender: SessionRecord,
  recipient: SessionRecord,
  key: string,
  waitSeconds: number
) {
  return sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: sender.id },
    kind: 'question',
    body: 'Which rounding mode should tax use?',
    audience: 'one',
    recipientId: recipient.id,
    waitSeconds,
    idempotencyKey: key,
    bodyHash: key,
  });
}

function answer(
  ctx: Ctx,
  sender: SessionRecord,
  recipient: SessionRecord,
  questionId: MessageId,
  key: string
) {
  return sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: sender.id },
    kind: 'answer',
    body: 'Half away from zero.',
    audience: 'one',
    recipientId: recipient.id,
    inReplyTo: questionId,
    idempotencyKey: key,
    bodyHash: key,
  });
}

type RememberedAboutSession = {
  endUnconfirmedRuns?: number;
  endAttemptRuns?: number;
  inconclusiveRuns?: number;
  lastFind?: 'found' | 'absent' | 'inconclusive';
  orphanEnded?: boolean;
};

async function rememberAboutSession(
  ctx: Ctx,
  sessionId: string,
  remembered: RememberedAboutSession
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO session_job_state (
       session_id, workspace_id, end_unconfirmed_runs, end_attempt_runs, inconclusive_runs,
       last_find, orphan_ended
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id) DO UPDATE SET
       end_unconfirmed_runs = EXCLUDED.end_unconfirmed_runs,
       end_attempt_runs = EXCLUDED.end_attempt_runs,
       inconclusive_runs = EXCLUDED.inconclusive_runs,
       last_find = EXCLUDED.last_find,
       orphan_ended = EXCLUDED.orphan_ended`,
    [
      sessionId,
      defaultWorkspaceId,
      remembered.endUnconfirmedRuns ?? 0,
      remembered.endAttemptRuns ?? 0,
      remembered.inconclusiveRuns ?? 0,
      remembered.lastFind ?? null,
      remembered.orphanEnded ?? false,
    ]
  );
}
