import { expect, spyOn, test } from 'bun:test';
import { retryDelayMs } from '@/core/alert-delivery-plan.ts';
import { deliverAlerts, toNotification } from '@/core/alert-notify.ts';
import { alertWords } from '@/core/alert-text.ts';
import { escalateSession } from '@/core/escalate.ts';
import { takeJob } from '@/core/job-run.ts';
import { runUsagePoll } from '@/core/usage-poll.ts';
import type { AlertRecord, AlertRule, AlertSeverity } from '@/domain/background-jobs.ts';
import { usagePollIntervalMs } from '@/domain/background-jobs.ts';
import { defaultWorkspaceId, requireAlertId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';
import type { Notification, Notifier } from '@/ports/notifier.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { team } from '@/testing/team.ts';
import { runAfterTest } from '@/testing/teardown.ts';

type Ctx = Awaited<ReturnType<typeof team>>;

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;

type Behaviour = { failing?: boolean; delayMs?: number; hang?: boolean };

function recordingNotifier(behaviour: Behaviour = {}) {
  const attempts: Notification[] = [];
  const delivered: Notification[] = [];
  let inFlight = 0;
  let overlap = 0;
  const notifier: Notifier = {
    async deliver(notification) {
      attempts.push(notification);
      inFlight += 1;
      overlap = Math.max(overlap, inFlight);

      try {
        if (behaviour.hang) await new Promise<void>(() => undefined);
        if (behaviour.delayMs !== undefined) await Bun.sleep(behaviour.delayMs);
        if (behaviour.failing) throw new Error('The webhook did not accept the notification.');

        delivered.push(notification);
      } finally {
        inFlight -= 1;
      }
    },
  };

  return { notifier, attempts, delivered, overlap: () => overlap };
}

function advance(ctx: Ctx, ms: number): void {
  ctx.deps.clock.advance(ms);
}

function agoText(ctx: Ctx, ms: number): string {
  return formatTime(new Date(ctx.deps.clock.now().getTime() - ms));
}

async function poll(ctx: Ctx, notifier: Notifier | null) {
  advance(ctx, usagePollIntervalMs);

  return runUsagePoll(
    ctx.deps,
    ctx.platforms,
    notifier === null ? { workerId: 'worker' } : { workerId: 'worker', notifier }
  );
}

async function deliver(ctx: Ctx, notifier: Notifier, deadlineMs?: number, lockOffset = 0) {
  advance(ctx, usagePollIntervalMs);

  const lockId = requirePresent(
    await takeJob(ctx.deps, 'usage_poll', 'worker', usagePollIntervalMs),
    'the job lock should be free'
  );

  await deliverAlerts(ctx.deps, { workerId: 'worker', notifier }, lockId + lockOffset, deadlineMs);
}

function escalate(ctx: Ctx, reason: string) {
  return escalateSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    reason,
  });
}

async function insertAlert(
  ctx: Ctx,
  input: {
    rule?: AlertRule;
    targetId: string;
    severity: AlertSeverity;
    openedAgoMs: number;
    notifiedAgoMs?: number;
  }
): Promise<AlertRecord> {
  const record: AlertRecord = {
    id: ctx.deps.ids.alert(),
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    rule: input.rule ?? 'escalation',
    targetId: input.targetId,
    severity: input.severity,
    reason: 'Needs a person.',
    openedAt: agoText(ctx, input.openedAgoMs),
    lastSeenAt: agoText(ctx, 0),
    clearedAt: null,
    notifiedAt: input.notifiedAgoMs === undefined ? null : agoText(ctx, input.notifiedAgoMs),
  };

  await ctx.deps.store.transact(tx => tx.insertAlert(record));

  return record;
}

async function insertDelivery(
  ctx: Ctx,
  input: { id: string; alertId: string; state: string; ageMs: number; attempts?: number }
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO alert_deliveries (id, workspace_id, alert_id, state, created_at, updated_at, attempts)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6)`,
    [
      input.id,
      defaultWorkspaceId,
      input.alertId,
      input.state,
      agoText(ctx, input.ageMs),
      input.attempts ?? 1,
    ]
  );
}

async function clearEscalation(ctx: Ctx): Promise<void> {
  await ctx.db.query(
    `UPDATE alerts SET cleared_at = $1::timestamptz WHERE rule = 'escalation' AND cleared_at IS NULL`,
    [agoText(ctx, 0)]
  );
}

async function deliveryStates(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.query<{ state: string }>(
    'SELECT state FROM alert_deliveries ORDER BY created_at, id'
  );

  return rows.rows.map(row => row.state);
}

function only(notifications: Notification[], rule: AlertRule): Notification[] {
  return notifications.filter(notification => notification.rule === rule);
}

function quietWarnings() {
  const warned = spyOn(console, 'warn').mockImplementation(() => undefined);

  runAfterTest(() => warned.mockRestore());

  return warned;
}

test('an alert is delivered once with its group and wording, and the alert records it', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();
  const alert = await escalate(ctx, 'I am blocked on a decision.');

  await poll(ctx, notifier);

  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);
  const tasks = await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id);
  const stored = await ctx.deps.store.transact(tx =>
    tx.openAlertByKey('escalation', ctx.planner.id)
  );

  expect(only(delivered, 'escalation')).toHaveLength(1);
  expect(only(delivered, 'escalation')[0]).toMatchObject({
    severity: 'critical',
    reminder: false,
    alertId: alert.id,
    workspaceId: defaultWorkspaceId,
    groupId: ctx.opened.group.id,
    groupName: group?.name,
    taskTitle: tasks.find(task => task.parent_id === null)?.title,
    sessionRole: 'planner',
    reason: 'I am blocked on a decision.',
    summary: alertWords('escalation').summary,
    action: alertWords('escalation').action,
  });
  expect(stored?.notifiedAt).not.toBeNull();
  expect(await deliveryStates(ctx)).toEqual(['sent']);
});

test('an alert that was notified is not delivered again before its reminder interval', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);
  await poll(ctx, notifier);
  await poll(ctx, notifier);

  expect(only(delivered, 'escalation')).toHaveLength(1);
});

test('a critical alert is reminded after four hours with a new delivery id', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);
  advance(ctx, 4 * hourMs - 2 * usagePollIntervalMs);
  await poll(ctx, notifier);

  expect(only(delivered, 'escalation')).toHaveLength(1);

  await poll(ctx, notifier);

  const sent = only(delivered, 'escalation');

  expect(sent).toHaveLength(2);
  expect(sent[1]?.reminder).toBe(true);
  expect(sent[1]?.deliveryId).not.toBe(sent[0]?.deliveryId);
  expect(await deliveryStates(ctx)).toEqual(['sent', 'sent']);
});

test('a normal alert is reminded after a day with a new delivery id', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  ctx.simulated.controls.setReportedUsage(80);
  await poll(ctx, notifier);
  advance(ctx, 24 * hourMs - 2 * usagePollIntervalMs);
  await poll(ctx, notifier);

  expect(only(delivered, 'budget_80')).toHaveLength(1);

  await poll(ctx, notifier);

  const sent = only(delivered, 'budget_80');

  expect(sent).toHaveLength(2);
  expect(sent[1]?.reminder).toBe(true);
  expect(sent[1]?.deliveryId).not.toBe(sent[0]?.deliveryId);
});

test('reminders stop a week after the alert opened, and the alert stays open', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);
  await ctx.db.query(
    `UPDATE alerts SET opened_at = $1::timestamptz, notified_at = $2::timestamptz
     WHERE rule = 'escalation'`,
    [agoText(ctx, 7 * 24 * hourMs + hourMs), agoText(ctx, 5 * hourMs)]
  );
  await poll(ctx, notifier);

  const stored = await ctx.deps.store.transact(tx =>
    tx.openAlertByKey('escalation', ctx.planner.id)
  );

  expect(only(delivered, 'escalation')).toHaveLength(1);
  expect(stored).not.toBeNull();
});

test('an alert that was not notified within a day of opening is never notified later', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await ctx.db.query(`UPDATE alerts SET opened_at = $1::timestamptz WHERE rule = 'escalation'`, [
    agoText(ctx, 25 * hourMs),
  ]);
  await poll(ctx, notifier);

  const stored = await ctx.deps.store.transact(tx =>
    tx.openAlertByKey('escalation', ctx.planner.id)
  );

  expect(only(delivered, 'escalation')).toHaveLength(0);
  expect(stored).not.toBeNull();
  expect(stored?.notifiedAt).toBeNull();
  expect(await deliveryStates(ctx)).toEqual([]);
});

test('an outstanding delivery blocks a second one for the same alert', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alert = await escalate(ctx, 'Blocked.');

  await insertDelivery(ctx, {
    id: 'dlv_outstanding',
    alertId: alert.id,
    state: 'sending',
    ageMs: 0,
  });
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  runAfterTest(() => errors.mockRestore());
  await runUsagePoll(ctx.deps, ctx.platforms, { workerId: 'worker', notifier });

  expect(only(attempts, 'escalation')).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual(['sending']);
  expect(errors).not.toHaveBeenCalled();
});

test('the database refuses a second outstanding delivery for one alert', async () => {
  const ctx = await team();
  const alert = await escalate(ctx, 'Blocked.');

  await insertDelivery(ctx, { id: 'dlv_first', alertId: alert.id, state: 'failed', ageMs: 0 });

  await expect(
    insertDelivery(ctx, { id: 'dlv_second', alertId: alert.id, state: 'sending', ageMs: 0 })
  ).rejects.toThrow('alert_deliveries_one_outstanding');

  await insertDelivery(ctx, { id: 'dlv_sent', alertId: alert.id, state: 'sent', ageMs: 0 });
  await insertDelivery(ctx, { id: 'dlv_expired', alertId: alert.id, state: 'expired', ageMs: 0 });
});

test('a delivery that is a day old expires and is never sent late', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alert = await escalate(ctx, 'Blocked.');

  await ctx.db.query(`UPDATE alerts SET opened_at = $1::timestamptz WHERE id = $2`, [
    agoText(ctx, 26 * hourMs),
    alert.id,
  ]);
  await insertDelivery(ctx, {
    id: 'dlv_old',
    alertId: alert.id,
    state: 'failed',
    ageMs: 25 * hourMs,
  });
  await poll(ctx, notifier);

  expect(only(attempts, 'escalation')).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual(['expired']);
});

test('a delivery for an alert that has cleared expires and is not sent', async () => {
  const ctx = await team();
  const behaviour: Behaviour = { failing: true };
  const { notifier, attempts } = recordingNotifier(behaviour);

  quietWarnings();
  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);

  expect(await deliveryStates(ctx)).toEqual(['failed']);

  await ctx.db.query(`UPDATE alerts SET cleared_at = $1::timestamptz WHERE rule = 'escalation'`, [
    agoText(ctx, 0),
  ]);
  behaviour.failing = false;
  await poll(ctx, notifier);

  expect(only(attempts, 'escalation')).toHaveLength(1);
  expect(await deliveryStates(ctx)).toEqual(['expired']);
});

test('a failed delivery is retried with the same delivery id', async () => {
  const ctx = await team();
  const behaviour: Behaviour = { failing: true };
  const { notifier, attempts, delivered } = recordingNotifier(behaviour);

  quietWarnings();
  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);

  expect(only(delivered, 'escalation')).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual(['failed']);

  behaviour.failing = false;
  await poll(ctx, notifier);

  const tried = only(attempts, 'escalation');

  expect(tried).toHaveLength(2);
  expect(tried[1]?.deliveryId).toBe(tried[0]?.deliveryId);
  expect(only(delivered, 'escalation')).toHaveLength(1);
  expect(await deliveryStates(ctx)).toEqual(['sent']);
});

test('a delivery stuck in sending is sent again after five minutes under its own id', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();
  const alert = await escalate(ctx, 'Blocked.');

  await insertDelivery(ctx, {
    id: 'dlv_stuck',
    alertId: alert.id,
    state: 'sending',
    ageMs: 6 * minuteMs,
  });
  await poll(ctx, notifier);

  expect(only(delivered, 'escalation').map(notification => notification.deliveryId)).toEqual([
    'dlv_stuck',
  ]);
  expect(await deliveryStates(ctx)).toEqual(['sent']);
});

test('a run delivers at most five, critical first and then the oldest', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();
  const critical = [
    await insertAlert(ctx, {
      targetId: 'ses_critical_1',
      severity: 'critical',
      openedAgoMs: minuteMs,
    }),
    await insertAlert(ctx, {
      targetId: 'ses_critical_2',
      severity: 'critical',
      openedAgoMs: 2 * minuteMs,
    }),
  ];
  const normal: AlertRecord[] = [];

  for (const [index, minutes] of [50, 40, 30, 20, 10].entries()) {
    normal.push(
      await insertAlert(ctx, {
        targetId: `ses_normal_${index}`,
        severity: 'normal',
        openedAgoMs: minutes * minuteMs,
      })
    );
  }

  await deliver(ctx, notifier);

  const first = delivered.map(notification => notification.alertId);

  expect(first).toHaveLength(5);
  expect(new Set(first)).toEqual(
    new Set([...critical, ...normal.slice(0, 3)].map(alert => alert.id))
  );

  await deliver(ctx, notifier);

  expect(delivered).toHaveLength(7);
  expect(new Set(delivered.slice(5).map(notification => notification.alertId))).toEqual(
    new Set(normal.slice(3).map(alert => alert.id))
  );
});

test('the deliveries of a run are sent at the same time', async () => {
  const ctx = await team();
  const { notifier, delivered, overlap } = recordingNotifier({ delayMs: 100 });

  await insertAlert(ctx, { targetId: 'ses_a', severity: 'critical', openedAgoMs: minuteMs });
  await insertAlert(ctx, { targetId: 'ses_b', severity: 'critical', openedAgoMs: minuteMs });
  await deliver(ctx, notifier);

  expect(delivered).toHaveLength(2);
  expect(overlap()).toBe(2);
});

test('a failing notifier does not fail the poll, and the failure is logged without the body', async () => {
  const ctx = await team();
  const { notifier } = recordingNotifier({ failing: true });
  const warned = quietWarnings();

  await escalate(ctx, 'The secret reason must not be logged.');

  const run = await poll(ctx, notifier);
  const logged = warned.mock.calls.map(call => String(call[0])).join('\n');

  expect(run.ran).toBe(true);
  expect(logged).toContain('will be retried');
  expect(logged).not.toContain('The secret reason must not be logged.');
});

test('a notifier that never answers is cut off and the delivery is marked failed', async () => {
  const ctx = await team();
  const { notifier } = recordingNotifier({ hang: true });
  const warned = quietWarnings();

  await escalate(ctx, 'Blocked.');

  const started = Date.now();

  await deliver(ctx, notifier, 50);

  expect(Date.now() - started).toBeLessThan(2000);
  expect(await deliveryStates(ctx)).toEqual(['failed']);
  expect(warned).toHaveBeenCalled();
});

test('no notifier means nothing is recorded and the alert is not marked notified', async () => {
  const ctx = await team();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, null);
  await poll(ctx, null);

  const stored = await ctx.deps.store.transact(tx =>
    tx.openAlertByKey('escalation', ctx.planner.id)
  );

  expect(await deliveryStates(ctx)).toEqual([]);
  expect(stored?.notifiedAt).toBeNull();
});

test('a worker with an old lock id sends and records nothing', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();

  await escalate(ctx, 'Blocked.');

  await expect(deliver(ctx, notifier, undefined, 1)).rejects.toMatchObject({ code: 'conflict' });

  expect(attempts).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual([]);
});

test('a condition that clears and returns is not notified again within the reminder interval', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);

  for (const round of [1, 2, 3]) {
    await clearEscalation(ctx);
    await escalate(ctx, `Blocked again, round ${round}.`);
    await poll(ctx, notifier);
  }

  const rows = await ctx.db.query<{ notified_at: string | null }>(
    `SELECT notified_at FROM alerts WHERE rule = 'escalation' ORDER BY opened_at, id`
  );

  expect(only(delivered, 'escalation')).toHaveLength(1);
  expect(rows.rows).toHaveLength(4);
  expect(new Set(rows.rows.map(row => String(row.notified_at))).size).toBe(1);
  expect(rows.rows[3]?.notified_at).not.toBeNull();
});

test('a condition that cleared and returned is reminded once after the interval', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);
  await clearEscalation(ctx);
  await escalate(ctx, 'Blocked again.');
  advance(ctx, 4 * hourMs - 2 * usagePollIntervalMs);
  await poll(ctx, notifier);

  expect(only(delivered, 'escalation')).toHaveLength(1);

  await poll(ctx, notifier);
  await poll(ctx, notifier);

  const sent = only(delivered, 'escalation');

  expect(sent).toHaveLength(2);
  expect(sent[1]?.reminder).toBe(true);
  expect(sent[1]?.deliveryId).not.toBe(sent[0]?.deliveryId);
});

test('an alert for a condition that was never notified is notified at once, even when another condition flapped', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);
  await clearEscalation(ctx);
  await insertAlert(ctx, { targetId: 'ses_never', severity: 'critical', openedAgoMs: minuteMs });
  await deliver(ctx, notifier);

  const fresh = delivered.filter(notification => notification.targetId === 'ses_never');

  expect(fresh).toHaveLength(1);
  expect(fresh[0]?.reminder).toBe(false);
});

test('a first notification is not retried once the alert is a day old', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alert = await insertAlert(ctx, {
    targetId: 'ses_old',
    severity: 'critical',
    openedAgoMs: 24 * hourMs - usagePollIntervalMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_first',
    alertId: alert.id,
    state: 'failed',
    ageMs: 10 * minuteMs,
  });
  await deliver(ctx, notifier);

  expect(attempts).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual(['expired']);
});

test('a first notification is still retried just before the alert is a day old', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alert = await insertAlert(ctx, {
    targetId: 'ses_old',
    severity: 'critical',
    openedAgoMs: 24 * hourMs - 2 * usagePollIntervalMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_first',
    alertId: alert.id,
    state: 'failed',
    ageMs: 10 * minuteMs,
  });
  await deliver(ctx, notifier);

  expect(attempts.map(notification => notification.deliveryId)).toEqual(['dlv_first']);
});

test('a reminder is not retried once the alert is a week old', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alert = await insertAlert(ctx, {
    targetId: 'ses_week',
    severity: 'critical',
    openedAgoMs: 7 * 24 * hourMs - usagePollIntervalMs,
    notifiedAgoMs: 5 * hourMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_reminder',
    alertId: alert.id,
    state: 'failed',
    ageMs: hourMs,
  });
  await deliver(ctx, notifier);

  expect(attempts).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual(['expired']);
});

test('a reminder is still retried just before the alert is a week old', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alert = await insertAlert(ctx, {
    targetId: 'ses_week',
    severity: 'critical',
    openedAgoMs: 7 * 24 * hourMs - 2 * usagePollIntervalMs,
    notifiedAgoMs: 5 * hourMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_reminder',
    alertId: alert.id,
    state: 'failed',
    ageMs: hourMs,
  });
  await deliver(ctx, notifier);

  expect(attempts.map(notification => notification.deliveryId)).toEqual(['dlv_reminder']);
});

test('no reminder is sent when the alert is exactly a week old, and one is sent just before', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await insertAlert(ctx, {
    targetId: 'ses_exactly',
    severity: 'critical',
    openedAgoMs: 7 * 24 * hourMs - usagePollIntervalMs,
    notifiedAgoMs: 5 * hourMs,
  });
  await insertAlert(ctx, {
    targetId: 'ses_before',
    severity: 'critical',
    openedAgoMs: 7 * 24 * hourMs - 2 * usagePollIntervalMs,
    notifiedAgoMs: 5 * hourMs,
  });
  await deliver(ctx, notifier);

  expect(delivered.map(notification => notification.targetId)).toEqual(['ses_before']);
});

test('a delivery that is exactly a day old expires, and one just under a day old is retried under its id', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const expiring = await insertAlert(ctx, {
    targetId: 'ses_expiring',
    severity: 'critical',
    openedAgoMs: hourMs,
  });
  const retried = await insertAlert(ctx, {
    targetId: 'ses_retried',
    severity: 'critical',
    openedAgoMs: 2 * hourMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_exactly_a_day',
    alertId: expiring.id,
    state: 'failed',
    ageMs: 24 * hourMs - usagePollIntervalMs,
  });
  await insertDelivery(ctx, {
    id: 'dlv_under_a_day',
    alertId: retried.id,
    state: 'failed',
    ageMs: 24 * hourMs - 2 * usagePollIntervalMs,
  });
  await deliver(ctx, notifier);

  const states = await ctx.db.query<{ id: string; state: string }>(
    `SELECT id, state FROM alert_deliveries WHERE id LIKE 'dlv_%' ORDER BY id`
  );

  expect(states.rows).toEqual([
    { id: 'dlv_exactly_a_day', state: 'expired' },
    { id: 'dlv_under_a_day', state: 'sent' },
  ]);
  expect(attempts.map(notification => notification.deliveryId)).toContain('dlv_under_a_day');
  expect(attempts.map(notification => notification.deliveryId)).not.toContain('dlv_exactly_a_day');
});

test('the wait before a delivery is retried doubles from five minutes and stops at an hour', () => {
  expect([1, 2, 3, 4, 5, 6, 10].map(retryDelayMs)).toEqual(
    [5, 10, 20, 40, 60, 60, 60].map(minutes => minutes * minuteMs)
  );
});

test('a failed delivery waits twice as long after each failure', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier({ failing: true });

  quietWarnings();
  await insertAlert(ctx, { targetId: 'ses_flaky', severity: 'critical', openedAgoMs: minuteMs });

  for (let run = 0; run < 8; run += 1) await deliver(ctx, notifier);

  const rows = await ctx.db.query<{ attempts: number }>('SELECT attempts FROM alert_deliveries');

  expect(attempts).toHaveLength(4);
  expect(rows.rows.map(row => Number(row.attempts))).toEqual([4]);
});

test('deliveries that keep failing do not keep a new alert from being delivered', async () => {
  const ctx = await team();
  const poisoned = new Set<string>();
  const delivered: Notification[] = [];
  const notifier: Notifier = {
    async deliver(notification) {
      if (poisoned.has(notification.alertId)) {
        throw new Error('The webhook did not accept the notification (HTTP 400).');
      }

      delivered.push(notification);
    },
  };

  quietWarnings();

  for (const index of [0, 1, 2, 3, 4]) {
    const alert = await insertAlert(ctx, {
      targetId: `ses_poisoned_${index}`,
      severity: 'critical',
      openedAgoMs: (3 + index) * hourMs,
    });

    poisoned.add(alert.id);
    await insertDelivery(ctx, {
      id: `dlv_poisoned_${index}`,
      alertId: alert.id,
      state: 'failed',
      ageMs: 2 * hourMs,
    });
  }

  const fresh = await insertAlert(ctx, {
    targetId: 'ses_fresh',
    severity: 'critical',
    openedAgoMs: minuteMs,
  });

  for (let run = 0; run < 3; run += 1) await deliver(ctx, notifier);

  expect(delivered.map(notification => notification.alertId)).toEqual([fresh.id]);
});

test('a worker that loses the lock while a delivery is out writes neither its result nor the alert', async () => {
  const ctx = await team();
  const stealing: Notifier = {
    async deliver() {
      await ctx.db.query(`UPDATE job_locks SET lock_id = lock_id + 1 WHERE job = 'usage_poll'`);
    },
  };

  await insertAlert(ctx, { targetId: 'ses_lost', severity: 'critical', openedAgoMs: minuteMs });

  await expect(deliver(ctx, stealing)).rejects.toMatchObject({ code: 'conflict' });

  const alerts = await ctx.db.query<{ notified_at: string | null }>(
    `SELECT notified_at FROM alerts WHERE target_id = 'ses_lost'`
  );

  expect(await deliveryStates(ctx)).toEqual(['sending']);
  expect(alerts.rows[0]?.notified_at).toBeNull();
});

test('a worker with an old lock id does not expire a delivery', async () => {
  const ctx = await team();
  const { notifier } = recordingNotifier();
  const alert = await insertAlert(ctx, {
    targetId: 'ses_aged',
    severity: 'critical',
    openedAgoMs: 25 * hourMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_aged',
    alertId: alert.id,
    state: 'failed',
    ageMs: 25 * hourMs,
  });

  await expect(deliver(ctx, notifier, undefined, 1)).rejects.toMatchObject({ code: 'conflict' });
  expect(await deliveryStates(ctx)).toEqual(['failed']);
});

test('the group, task and session are read only when something is sent', async () => {
  const ctx = await team();
  const { notifier } = recordingNotifier();
  let snapshots = 0;
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx =>
      work(
        new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);

            if (typeof value !== 'function') return value;
            if (prop === 'loadJobSnapshot') snapshots += 1;

            return value.bind(target);
          },
        })
      )
    );

  await deliver(ctx, notifier);

  expect(snapshots).toBe(0);

  await insertAlert(ctx, { targetId: 'ses_named', severity: 'critical', openedAgoMs: minuteMs });
  await deliver(ctx, notifier);

  expect(snapshots).toBe(1);
});

test('a delivery for an alert of a rule this release does not know is left alone', async () => {
  const ctx = await team();
  const { notifier, attempts } = recordingNotifier();
  const alertId = ctx.deps.ids.alert();

  await ctx.db.query(
    `INSERT INTO alerts (id, workspace_id, group_id, rule, target_id, severity, reason, opened_at, last_seen_at)
     VALUES ($1, $2, $3, 'rule_from_a_newer_release', 'ses_future', 'critical', 'Newer.', $4::timestamptz, $4::timestamptz)`,
    [alertId, defaultWorkspaceId, ctx.opened.group.id, agoText(ctx, 25 * hourMs)]
  );
  await insertDelivery(ctx, { id: 'dlv_future', alertId, state: 'failed', ageMs: 25 * hourMs });
  await deliver(ctx, notifier);

  expect(attempts).toHaveLength(0);
  expect(await deliveryStates(ctx)).toEqual(['failed']);
});

test('a database error while writing one result does not strand the other results', async () => {
  const ctx = await team();
  const { notifier } = recordingNotifier();
  const transact = ctx.deps.store.transact.bind(ctx.deps.store);
  let failed = false;

  quietWarnings();
  await insertAlert(ctx, { targetId: 'ses_first', severity: 'critical', openedAgoMs: minuteMs });
  await insertAlert(ctx, { targetId: 'ses_second', severity: 'critical', openedAgoMs: minuteMs });
  ctx.deps.store.transact = work =>
    transact(tx =>
      work(
        new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);

            if (typeof value !== 'function') return value;
            if (prop !== 'finishAlertDelivery') return value.bind(target);

            return (...args: unknown[]) => {
              if (!failed) {
                failed = true;

                throw new Error('The database dropped the connection.');
              }

              return value.apply(target, args);
            };
          },
        })
      )
    );

  await deliver(ctx, notifier);

  expect((await deliveryStates(ctx)).sort()).toEqual(['sending', 'sent']);
});

test('a condition that returns after more than its interval is a first notification, not a reminder', async () => {
  const ctx = await team();
  const { notifier, delivered } = recordingNotifier();

  await escalate(ctx, 'Blocked.');
  await poll(ctx, notifier);
  await clearEscalation(ctx);
  advance(ctx, 5 * hourMs);
  await escalate(ctx, 'A new incident.');
  await poll(ctx, notifier);

  const sent = only(delivered, 'escalation');

  expect(sent).toHaveLength(2);
  expect(sent[1]?.reminder).toBe(false);
});

test('a delivery that expires while its alert is still open is logged as dropped', async () => {
  const ctx = await team();
  const warned = quietWarnings();
  const alert = await insertAlert(ctx, {
    targetId: 'ses_dropped',
    severity: 'critical',
    openedAgoMs: 30 * hourMs,
    notifiedAgoMs: 29 * hourMs,
  });

  await insertDelivery(ctx, {
    id: 'dlv_dropped',
    alertId: alert.id,
    state: 'failed',
    ageMs: 25 * hourMs,
  });
  await deliver(ctx, recordingNotifier().notifier);

  expect(warned.mock.calls.some(call => String(call[0]).includes('dropped'))).toBe(true);
});

test.each([
  [0, '0 minutes'],
  [1, '1 minute'],
  [2, '2 minutes'],
  [61, '61 minutes'],
])('an alert that opened %d min before it is sent is described as %s', (minutes, words) => {
  const sentAt = '2026-11-19T10:00:00.000Z';
  const alert: AlertRecord = {
    id: requireAlertId('alr_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    workspaceId: defaultWorkspaceId,
    groupId: null,
    rule: 'session_dead',
    targetId: 'ses_x',
    severity: 'critical',
    reason: null,
    openedAt: new Date(Date.parse(sentAt) - minutes * minuteMs).toISOString(),
    lastSeenAt: sentAt,
    clearedAt: null,
    notifiedAt: null,
  };

  expect(
    toNotification({ groups: [], tasks: [], sessions: [] }, alert, 'd', false, sentAt).openFor
  ).toBe(words);
});
