import { expect, test } from 'bun:test';
import { escalateSession } from '@/core/escalate.ts';
import { endSession } from '@/core/session-end.ts';
import { escalationCap, escalationWindowMs } from '@/domain/background-jobs.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { credentialMarker } from '@/domain/message.ts';
import { formatTime } from '@/domain/time.ts';
import { team } from '@/testing/team.ts';

type Ctx = Awaited<ReturnType<typeof team>>;

function escalate(ctx: Ctx, reason: string) {
  return escalateSession(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    reason,
  });
}

async function insertEscalations(
  ctx: Ctx,
  count: number,
  options: { groupId: string; ageMs: number }
): Promise<void> {
  const openedAt = formatTime(new Date(ctx.deps.clock.now().getTime() - options.ageMs));

  for (let index = 0; index < count; index += 1) {
    await ctx.db.query(
      `INSERT INTO alerts (
         id, workspace_id, group_id, rule, target_id, severity, reason, opened_at, last_seen_at
       ) VALUES ($1, $2, $3, 'escalation', $4, 'critical', 'Earlier.', $5::timestamptz,
                 $5::timestamptz)`,
      [
        `alr_${options.groupId}_${index}`,
        defaultWorkspaceId,
        options.groupId,
        `ses_${options.groupId}_${index}`,
        openedAt,
      ]
    );
  }
}

async function storedEscalation(ctx: Ctx) {
  return ctx.deps.store.transact(tx => tx.openAlertByKey('escalation', ctx.planner.id));
}

test('escalate opens one alert and a second call updates the reason', async () => {
  const ctx = await team();
  const first = await escalate(ctx, 'I am blocked on a decision.');
  const second = await escalate(ctx, 'The decision is still missing.');
  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  expect(snapshot.alerts.map(alert => alert.id)).toEqual([first.id]);
  expect(snapshot.alerts[0]?.reason).toBe('The decision is still missing.');
  expect(second.reason).toBe('The decision is still missing.');
});

test('a second call with the same reason writes nothing', async () => {
  const ctx = await team();
  const first = await escalate(ctx, 'I am blocked on a decision.');

  ctx.deps.clock.advance(60_000);
  await escalate(ctx, 'I am blocked on a decision.');

  expect((await storedEscalation(ctx))?.lastSeenAt).toBe(first.lastSeenAt);
});

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

  await escalate(ctx, 'Need a person.');

  expect(order.slice(0, 5)).toEqual([
    'lockWorkspace',
    'lockGroup',
    'lockTask',
    'lockTask',
    'lockSession',
  ]);
});

test('the reason has this service credentials redacted', async () => {
  const ctx = await team();
  const alert = await escalate(ctx, `Leaked ses_${'a'.repeat(43)} here.`);

  expect(alert.reason).toBe(`Leaked ${credentialMarker} here.`);
  expect((await storedEscalation(ctx))?.reason).toBe(`Leaked ${credentialMarker} here.`);
});

test('a reason of 1,024 bytes is kept and one of 1,025 bytes is refused', async () => {
  const ctx = await team();

  expect((await escalate(ctx, 'x'.repeat(1024))).reason).toBe('x'.repeat(1024));
  await expect(escalate(ctx, 'x'.repeat(1025))).rejects.toMatchObject({
    code: 'validation_failed',
  });
});

test('a released session can escalate', async () => {
  const ctx = await team();

  await ctx.db.query(`UPDATE sessions SET life = 'released' WHERE id = $1`, [ctx.planner.id]);

  expect((await escalate(ctx, 'Released, and still stuck.')).rule).toBe('escalation');
});

test('a session that asked to end cannot escalate', async () => {
  const ctx = await team();

  await ctx.db.query(`UPDATE sessions SET end_requested_at = now() WHERE id = $1`, [
    ctx.planner.id,
  ]);

  await expect(escalate(ctx, 'Too late.')).rejects.toMatchObject({ code: 'session_not_active' });
});

test('an ended session cannot escalate, because ending clears its token', async () => {
  const ctx = await team();

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'service' },
    reason: 'The planner is done.',
  });

  await expect(escalate(ctx, 'Too late.')).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('a group that opened its escalations for the hour cannot open another', async () => {
  const ctx = await team();

  await insertEscalations(ctx, escalationCap, { groupId: ctx.opened.group.id, ageMs: 0 });

  await expect(escalate(ctx, 'One more.')).rejects.toMatchObject({ code: 'rate_limited' });
});

test('escalations opened more than an hour ago do not count towards the limit', async () => {
  const ctx = await team();

  await insertEscalations(ctx, escalationCap, {
    groupId: ctx.opened.group.id,
    ageMs: escalationWindowMs + 60_000,
  });

  expect((await escalate(ctx, 'A new hour.')).rule).toBe('escalation');
});

test('escalations of another group do not count towards the limit', async () => {
  const ctx = await team();

  await insertEscalations(ctx, escalationCap, { groupId: 'grp_elsewhere', ageMs: 0 });

  expect((await escalate(ctx, 'Not their problem.')).rule).toBe('escalation');
});

test('a session that already has an alert can update it when its group is at the limit', async () => {
  const ctx = await team();

  await escalate(ctx, 'First reason.');
  await insertEscalations(ctx, escalationCap - 1, { groupId: ctx.opened.group.id, ageMs: 0 });

  expect((await escalate(ctx, 'Second reason.')).reason).toBe('Second reason.');
});
