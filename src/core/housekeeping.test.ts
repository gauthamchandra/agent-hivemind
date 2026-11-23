import { expect, test } from 'bun:test';
import { runDueJobs } from '@/core/background-jobs.ts';
import { runHousekeeping } from '@/core/housekeeping.ts';
import { openGroup } from '@/core/session-open.ts';
import {
  closedGroupRetentionMs,
  housekeepingDeadlineMs,
  housekeepingIntervalMs,
  jobLockMs,
} from '@/domain/background-jobs.ts';
import { defaultWorkspaceId, type GroupId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';
import type { Store, UnitOfWork } from '@/ports/storage.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { checkoutGroup } from '@/testing/fixtures.ts';
import { addChild, team } from '@/testing/team.ts';

type Ctx = Awaited<ReturnType<typeof team>>;
type Life = 'starting' | 'live' | 'released' | 'ended' | 'start_failed';

test('a closed group is removed 90 days after it closed, with its history and job rows', async () => {
  const ctx = await team();
  const kept = await openSecondGroup(ctx);

  await addChild(ctx.deps, ctx.opened.group.id, ctx.planner.id);
  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs });
  await insertJobRows(ctx, ctx.opened.group.id, ctx.planner.id, ctx.opened.root.id);
  await insertClearedAlert(ctx, kept.group.id, 'kept-alert', 'kept-delivery');

  const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(run).toEqual({ ran: true, lockId: 1 });
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
  expect(await ctx.deps.store.tasks(defaultWorkspaceId, ctx.opened.group.id)).toEqual([]);
  expect(await ctx.deps.store.events(defaultWorkspaceId, ctx.opened.group.id)).toEqual([]);
  expect(await ctx.deps.store.sessions(defaultWorkspaceId, ctx.opened.group.id)).toEqual([]);
  expect(await count(ctx, 'alerts', ctx.opened.group.id)).toBe(0);
  expect(await countWhere(ctx, 'alerts', 'id = $1', ['orphan-alert'])).toBe(0);
  expect(await countWhere(ctx, 'alert_deliveries', 'id = $1', ['removed-delivery'])).toBe(0);
  expect(await countWhere(ctx, 'planned_actions', 'target_id = $1', [ctx.planner.id])).toBe(0);
  expect(await countWhere(ctx, 'planned_actions', 'target_id = $1', [ctx.opened.group.id])).toBe(0);
  expect(await count(ctx, 'messages', ctx.opened.group.id)).toBe(0);
  expect(await count(ctx, 'outbox_copies', ctx.opened.group.id)).toBe(0);
  expect(await count(ctx, 'waits', ctx.opened.group.id)).toBe(0);
  expect(await count(ctx, 'spawn_log', ctx.opened.group.id)).toBe(0);
  expect(await count(ctx, 'context_notes', ctx.opened.group.id)).toBe(0);
  expect(await countWhere(ctx, 'enrollment_codes', 'session_id = $1', [ctx.planner.id])).toBe(0);
  expect(await countWhere(ctx, 'session_job_state', 'session_id = $1', [ctx.planner.id])).toBe(0);
  expect(await ctx.deps.store.group(defaultWorkspaceId, kept.group.id)).not.toBeNull();
  expect(await count(ctx, 'alerts', kept.group.id)).toBe(1);
  expect(await ctx.deps.store.events(defaultWorkspaceId, kept.group.id)).not.toEqual([]);
});

test('retention keeps a group that closed less than 90 days ago', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs - 1 });

  const closedBefore = formatTime(
    new Date(ctx.deps.clock.now().getTime() - closedGroupRetentionMs)
  );
  const listed = await ctx.deps.store.transact(tx => tx.groupsClosedBefore(closedBefore));
  const lockId = await takeHousekeepingLock(ctx);
  const outcome = await ctx.deps.store.transact(tx =>
    tx.removeClosedGroup({
      groupId: ctx.opened.group.id,
      lockId,
      now: formatTime(ctx.deps.clock.now()),
      closedBefore,
    })
  );

  expect(listed).not.toContain(ctx.opened.group.id);
  expect(outcome).toBe('kept');
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
});

test('retention keeps an open group', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, {
    ageMs: closedGroupRetentionMs,
    status: 'open',
  });

  const closedBefore = formatTime(
    new Date(ctx.deps.clock.now().getTime() - closedGroupRetentionMs)
  );
  const listed = await ctx.deps.store.transact(tx => tx.groupsClosedBefore(closedBefore));
  const lockId = await takeHousekeepingLock(ctx);
  const outcome = await ctx.deps.store.transact(tx =>
    tx.removeClosedGroup({
      groupId: ctx.opened.group.id,
      lockId,
      now: formatTime(ctx.deps.clock.now()),
      closedBefore,
    })
  );

  expect(listed).not.toContain(ctx.opened.group.id);
  expect(outcome).toBe('kept');
  expect((await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id))?.status).toBe(
    'open'
  );
});

test('a closed group younger than 90 days keeps its cleared alert and delivery', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs - 1 });
  await insertClearedAlert(ctx, ctx.opened.group.id, 'young-alert', 'young-delivery');
  await insertPlannedAction(ctx, ctx.planner.id, 'young-action');

  const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(run.ran).toBe(true);
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
  expect(await count(ctx, 'alerts', ctx.opened.group.id)).toBe(1);
  expect(await countWhere(ctx, 'alert_deliveries', 'id = $1', ['young-delivery'])).toBe(1);
  expect(await countWhere(ctx, 'planned_actions', 'id = $1', ['young-action'])).toBe(1);
});

test('an open group is kept even when a closed time is already 90 days ago', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, {
    ageMs: closedGroupRetentionMs,
    status: 'open',
  });

  await runHousekeeping(ctx.deps, { workerId: 'worker' });

  const group = await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id);

  expect(group?.status).toBe('open');
});

for (const life of ['starting', 'live', 'released'] as const) {
  test(`a ${life} session keeps a group that closed 90 days ago`, async () => {
    const ctx = await team();

    await closeForRetention(ctx, ctx.opened.group.id, {
      ageMs: closedGroupRetentionMs,
      life,
    });

    const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

    expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
    expect(await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id)).toMatchObject({
      life,
    });
    await expectRemovalKeeps(ctx, ctx.opened.group.id, run.lockId);
  });
}

test('a session that still owes a final reading keeps the closed group', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, {
    ageMs: closedGroupRetentionMs,
    life: 'ended',
    finalUsagePending: true,
  });

  const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  const session = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
  expect(session?.life).toBe('ended');
  expect(session?.final_usage_pending).toBe(true);
  await expectRemovalKeeps(ctx, ctx.opened.group.id, run.lockId);
});

test('a session that still owes a platform stop keeps the closed group', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, {
    ageMs: closedGroupRetentionMs,
    life: 'ended',
    platformStopPending: true,
  });

  const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  const session = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
  expect(session?.platform_stop_pending).toBe(true);
  await expectRemovalKeeps(ctx, ctx.opened.group.id, run.lockId);
});

test('a failed start that owes nothing is removed with its closed group', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, {
    ageMs: closedGroupRetentionMs,
    life: 'start_failed',
  });

  await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
});

test('a task event cannot be deleted or updated outside retention', async () => {
  const ctx = await team();
  const eventId = (await ctx.deps.store.events(defaultWorkspaceId, ctx.opened.group.id))[0]?.id;

  expect(eventId).toBeDefined();
  await expect(ctx.db.query('DELETE FROM task_events WHERE id = $1', [eventId])).rejects.toThrow(
    'task events are append-only'
  );
  await expect(
    ctx.db.transaction(async tx => {
      await tx.query(`SELECT set_config('hivemind.retention', 'on', true)`);
      await tx.query(`UPDATE task_events SET note = 'changed' WHERE id = $1`, [eventId]);
    })
  ).rejects.toThrow('task events are append-only');
});

test('retention after a session lock is refused', async () => {
  const ctx = await team();
  const now = formatTime(ctx.deps.clock.now());
  const outOfOrder = ctx.deps.store.transact(async tx => {
    await tx.lockSession(defaultWorkspaceId, ctx.planner.id);
    await tx.removeClosedGroup({
      groupId: ctx.opened.group.id,
      lockId: 1,
      now,
      closedBefore: now,
    });
  });

  await expect(outOfOrder).rejects.toThrow('Lock order violated: job lock locked after session.');
});

test('a housekeeping write under an old lock id removes nothing', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs });
  await insertClearedAlert(ctx, ctx.opened.group.id, 'stale-alert', 'stale-delivery');
  stealLockAfterListing(ctx);

  await expect(runHousekeeping(ctx.deps, { workerId: 'worker' })).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
  expect(await count(ctx, 'alerts', ctx.opened.group.id)).toBe(1);
});

test('older blocked groups do not spend the deadline ahead of a later eligible group', async () => {
  const ctx = await team();
  const later = await openAnotherGroup(ctx, 'Ledger', 'retention-later-group');

  await closeForRetention(ctx, ctx.opened.group.id, {
    ageMs: closedGroupRetentionMs + 86_400_000,
    life: 'live',
  });
  await closeForRetention(ctx, later.group.id, {
    ageMs: closedGroupRetentionMs,
    sessionId: later.session.id,
  });
  advanceClockWhenKept(ctx);

  const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(run.ran).toBe(true);
  expect(await ctx.deps.store.group(defaultWorkspaceId, later.group.id)).toBeNull();
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();
  await expectRemovalKeeps(ctx, ctx.opened.group.id, run.lockId);
});

test('housekeeping stops at its deadline and leaves the next group', async () => {
  const ctx = await team();
  const second = await openSecondGroup(ctx);

  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs + 86_400_000 });
  await closeForRetention(ctx, second.group.id, {
    ageMs: closedGroupRetentionMs,
    sessionId: second.session.id,
  });
  advanceClockAfterFirstRemoval(ctx);

  const run = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(run.ran).toBe(true);
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
  expect(await ctx.deps.store.group(defaultWorkspaceId, second.group.id)).not.toBeNull();
});

test('housekeeping runs at most once every 24 hours', async () => {
  const ctx = await team();
  const hour = 60 * 60 * 1000;

  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs - hour });

  const first = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(first.ran).toBe(true);
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();

  ctx.deps.clock.advance(jobLockMs + 1);

  const second = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(second).toEqual({ ran: false, lockId: null });

  ctx.deps.clock.advance(housekeepingIntervalMs);

  const third = await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(third.ran).toBe(true);
  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
});

test('housekeeping removes a group after the retention it was given', async () => {
  const ctx = await team();
  const tenDays = 10 * 24 * 60 * 60 * 1000;

  ctx.deps.closedGroupRetentionMs = tenDays;
  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: tenDays - 1 });
  await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).not.toBeNull();

  ctx.deps.clock.advance(housekeepingIntervalMs);
  await runHousekeeping(ctx.deps, { workerId: 'worker' });

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
});

test('the background run removes a closed group that is due', async () => {
  const ctx = await team();

  await closeForRetention(ctx, ctx.opened.group.id, { ageMs: closedGroupRetentionMs });

  await runDueJobs(ctx.deps, ctx.platforms, { workerId: 'worker' });

  expect(await ctx.deps.store.group(defaultWorkspaceId, ctx.opened.group.id)).toBeNull();
});

async function takeHousekeepingLock(ctx: Ctx): Promise<number> {
  const now = formatTime(ctx.deps.clock.now());
  const lockId = await ctx.deps.store.transact(tx =>
    tx.takeJobLock({
      job: 'housekeeping',
      lockedBy: 'worker',
      now,
      expiresAt: formatTime(new Date(ctx.deps.clock.now().getTime() + jobLockMs)),
      dueAt: formatTime(new Date(0)),
    })
  );

  if (lockId === null) throw new Error('housekeeping lock should be free');

  return lockId;
}

async function openSecondGroup(ctx: Ctx) {
  return openAnotherGroup(ctx, 'Refunds', 'retention-second-group');
}

async function openAnotherGroup(ctx: Ctx, name: string, key: string) {
  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    ...checkoutGroup,
    name,
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: key,
    bodyHash: key,
  });

  expect(opened.outcome).toBe('live');
  if (opened.outcome !== 'live') throw new Error('the second planner did not start');

  return opened;
}

async function closeForRetention(
  ctx: Ctx,
  groupId: string,
  options: {
    ageMs: number;
    life?: Life;
    finalUsagePending?: boolean;
    platformStopPending?: boolean;
    status?: 'open' | 'closed';
    sessionId?: string;
  }
) {
  const closedAt = formatTime(new Date(ctx.deps.clock.now().getTime() - options.ageMs));
  const sessionColumn = options.sessionId === undefined ? 'group_id' : 'id';

  await ctx.db.query(
    `UPDATE sessions
     SET life = $2,
         final_usage_pending = $3,
         platform_stop_pending = $4,
         token_hash = NULL,
         platform_session_ref = NULL
     WHERE ${sessionColumn} = $1`,
    [
      options.sessionId ?? groupId,
      options.life ?? 'ended',
      options.finalUsagePending ?? false,
      options.platformStopPending ?? false,
    ]
  );
  await ctx.db.query(`UPDATE groups SET status = $2, closed_at = $3::timestamptz WHERE id = $1`, [
    groupId,
    options.status ?? 'closed',
    closedAt,
  ]);
}

async function insertJobRows(ctx: Ctx, groupId: string, sessionId: string, taskId: string) {
  const now = formatTime(ctx.deps.clock.now());

  await insertClearedAlert(ctx, groupId, 'removed-alert', 'removed-delivery');
  await ctx.db.query(
    `INSERT INTO alerts (
       id, workspace_id, group_id, rule, target_id, severity, opened_at, last_seen_at
     ) VALUES ('orphan-alert', $1, NULL, 'budget_80', $2, 'normal', $3::timestamptz, $3::timestamptz)`,
    [defaultWorkspaceId, sessionId, now]
  );
  await insertPlannedAction(ctx, sessionId, 'removed-session-action');
  await insertPlannedAction(ctx, groupId, 'removed-group-action');
  await ctx.db.query(
    `INSERT INTO messages (
       id, workspace_id, group_id, sender_kind, sender_id, sender_role, sender_task_id,
       kind, audience, body, idempotency_key, created_at
     ) VALUES (
       'msg_retention', $1, $2, 'session', $3, 'planner', $4,
       'note', 'all', 'A note the group kept.', 'retention-message', $5::timestamptz
     )`,
    [defaultWorkspaceId, groupId, sessionId, taskId, now]
  );
  await ctx.db.query(
    `INSERT INTO outbox_copies (
       id, workspace_id, group_id, connection_id, message_id, recipient_id, sequence,
       state, next_attempt_at, created_at
     ) VALUES (
       'cpy_retention', $1, $2, $3, 'msg_retention', $4, 1,
       'queued', $5::timestamptz, $5::timestamptz
     )`,
    [defaultWorkspaceId, groupId, ctx.connectionId, sessionId, now]
  );
  await ctx.db.query(
    `INSERT INTO waits (
       id, workspace_id, group_id, waiting_session_id, awaited_session_id, deadline_at, created_at
     ) VALUES (
       'wait_retention', $1, $2, $3, $3, $4::timestamptz, $4::timestamptz
     )`,
    [defaultWorkspaceId, groupId, sessionId, now]
  );
  await ctx.db.query(
    `INSERT INTO enrollment_codes (id, workspace_id, session_id, code_hash, created_at)
     VALUES ('enc_retention', $1, $2, 'retention-code', $3::timestamptz)`,
    [defaultWorkspaceId, sessionId, now]
  );
  await ctx.db.query(`INSERT INTO session_job_state (session_id, workspace_id) VALUES ($1, $2)`, [
    sessionId,
    defaultWorkspaceId,
  ]);
  await ctx.db.query(
    `INSERT INTO context_notes (workspace_id, group_id, position, name, body)
     VALUES ($1, $2, 0, 'scope', 'What the group was for.')`,
    [defaultWorkspaceId, groupId]
  );
}

async function insertClearedAlert(ctx: Ctx, groupId: string, alertId: string, deliveryId: string) {
  const now = formatTime(ctx.deps.clock.now());

  await ctx.db.query(
    `INSERT INTO alerts (
       id, workspace_id, group_id, rule, target_id, severity, opened_at, last_seen_at, cleared_at
     ) VALUES (
       $1, $2, $3, 'spend_unknown', $3, 'normal', $4::timestamptz, $4::timestamptz, $4::timestamptz
     )`,
    [alertId, defaultWorkspaceId, groupId, now]
  );
  await ctx.db.query(
    `INSERT INTO alert_deliveries (
       id, workspace_id, alert_id, state, attempts, created_at, updated_at
     ) VALUES ($1, $2, $3, 'sent', 1, $4::timestamptz, $4::timestamptz)`,
    [deliveryId, defaultWorkspaceId, alertId, now]
  );
}

async function insertPlannedAction(ctx: Ctx, targetId: string, id: string) {
  const now = formatTime(ctx.deps.clock.now());

  await ctx.db.query(
    `INSERT INTO planned_actions (
       id, job, action, target_id, workspace_id, lock_id, state, created_at
     ) VALUES ($1, 'usage_poll', 'poll', $2, $3, 1, 'done', $4::timestamptz)`,
    [id, targetId, defaultWorkspaceId, now]
  );
}

function stealLockAfterListing(ctx: Ctx) {
  const transact = ctx.deps.store.transact.bind(ctx.deps.store);
  let listed = false;

  ctx.deps.store.transact = watchTransaction(transact, async result => {
    if (!listed && Array.isArray(result) && result.length > 0) {
      listed = true;
      await ctx.db.query(`UPDATE job_locks SET lock_id = lock_id + 1 WHERE job = 'housekeeping'`);
    }
  });
}

async function expectRemovalKeeps(ctx: Ctx, groupId: GroupId, lockId: number | null) {
  const now = formatTime(ctx.deps.clock.now());
  const outcome = await ctx.deps.store.transact(tx =>
    tx.removeClosedGroup({
      groupId,
      lockId: lockId ?? 0,
      now,
      closedBefore: formatTime(
        new Date(ctx.deps.clock.now().getTime() - ctx.deps.closedGroupRetentionMs)
      ),
    })
  );

  expect(outcome).toBe('kept');
  expect(await ctx.deps.store.group(defaultWorkspaceId, groupId)).not.toBeNull();
}

function advanceClockWhenKept(ctx: Ctx) {
  const transact = ctx.deps.store.transact.bind(ctx.deps.store);

  ctx.deps.store.transact = watchTransaction(transact, result => {
    if (result === 'kept') ctx.deps.clock.advance(housekeepingDeadlineMs + 1);
  });
}

function advanceClockAfterFirstRemoval(ctx: Ctx) {
  const transact = ctx.deps.store.transact.bind(ctx.deps.store);

  ctx.deps.store.transact = watchTransaction(transact, result => {
    if (result === 'removed') ctx.deps.clock.advance(housekeepingDeadlineMs + 1);
  });
}

function watchTransaction(
  transact: Store['transact'],
  after: (result: unknown) => Promise<void> | void
): Store['transact'] {
  return async <T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> => {
    const result = await transact(work);

    await after(result);

    return result;
  };
}

function count(ctx: Ctx, table: string, groupId: string): Promise<number> {
  return countWhere(ctx, table, 'group_id = $1', [groupId]);
}

async function countWhere(
  ctx: Ctx,
  table: string,
  filter: string,
  params: unknown[]
): Promise<number> {
  const result = await ctx.db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE ${filter}`,
    params
  );
  const row = requirePresent(result.rows[0], 'the count query should return one row');

  return requirePresent(row.count, 'the count query should return a count');
}
