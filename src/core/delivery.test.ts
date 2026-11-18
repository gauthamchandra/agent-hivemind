import { expect, test } from 'bun:test';
import type { Io } from '@/cli/io.ts';
import { runHivemind } from '@/cli/main.ts';
import { DeliveryStopped, drainOutbox } from '@/core/delivery.ts';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { copiesFor, listInbox, recordWait, waitsFor } from '@/core/message-read.ts';
import { reportTransition } from '@/core/report-records.ts';
import { sendMessage } from '@/core/send-message.ts';
import { endSession } from '@/core/session-end.ts';
import { openGroup } from '@/core/session-open.ts';
import { startSession } from '@/core/session-start.ts';
import { createChildTask } from '@/core/task-records.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { credentialMarker, mailLogLimit, senderLimit } from '@/domain/message.ts';
import type { SessionRecord } from '@/domain/model.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootHttpService, bootService, type Service } from '@/testing/boot.ts';
import { checkoutGroup, note } from '@/testing/fixtures.ts';
import { bearer, expectStatus, sendJson } from '@/testing/http.ts';
import { replaceAdapter } from '@/testing/platforms.ts';

const dayMs = 24 * 60 * 60 * 1000;
const claimMs = 60 * 1000;

async function team() {
  const ctx = await bootService();

  return assemble(
    ctx,
    requirePresent(
      (await openInstallation(ctx.deps)).bootstrapSecret,
      'the empty store should print a bootstrap key'
    )
  );
}

async function httpTeam() {
  const ctx = await bootHttpService();

  return assemble(ctx, ctx.bootstrap);
}

async function assemble<T extends Service>(ctx: T, secret: string) {
  const admin = await createFirstAdministrator(ctx.deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });

  const creator = await createOperatorKey(ctx.deps, {
    bootstrapSecret: secret,
    name: 'creator',
    role: 'creator',
    expiresAt: null,
  });

  const opened = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: admin.id,
    ...checkoutGroup,
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'open-group',
    bodyHash: 'open-group-body',
  });

  expect(opened.outcome).toBe('live');

  if (opened.outcome !== 'live') throw new Error('planner did not start');

  const root = opened.root;
  const analyzing =
    root.state === 'planned'
      ? (
          await reportTransition(ctx.deps, {
            workspaceId: defaultWorkspaceId,
            groupId: opened.group.id,
            taskId: root.id,
            expectedVersion: root.version,
            actor: { kind: 'session', role: 'planner', sessionId: opened.session.id, live: true },
            to: 'analyzing',
            note,
            evidence: [],
            nextVerificationMode: null,
          })
        ).task
      : root;
  const created = await createChildTask(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: opened.group.id,
    actor: { sessionId: opened.session.id, live: true },
    title: 'Calculate tax',
    description: 'Move the tax calculation behind an interface.',
    verificationMode: null,
    dependsOn: [],
  });
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: opened.group.id,
    taskId: created.task.id,
    role: 'implementer',
    instructions: 'Implement the tax change.',
    actor: { kind: 'session', sessionId: opened.session.id },
    idempotencyKey: 'start-implementer',
    bodyHash: 'start-implementer',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');

  if (started.outcome !== 'live') throw new Error('implementer did not start');

  return {
    ...ctx,
    admin,
    groupId: opened.group.id,
    root: analyzing,
    planner: opened.session,
    implementer: started.session,
    creatorSecret: creator.secret,
    plannerToken: requirePresent(
      ctx.simulated.secretFor(opened.session.id),
      'the planner should receive a token'
    ),
    implementerToken: requirePresent(
      ctx.simulated.secretFor(started.session.id),
      'the implementer should receive a token'
    ),
  };
}

function sendNote(
  ctx: Awaited<ReturnType<typeof team>>,
  sender: SessionRecord,
  recipient: SessionRecord,
  body: string,
  key: string
) {
  return sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: sender.id },
    kind: 'note',
    body,
    audience: 'one',
    recipientId: recipient.id,
    idempotencyKey: key,
    bodyHash: key,
  });
}

async function deliveredBodies(ctx: Service): Promise<string[]> {
  return ctx.simulated
    .sentMessages()
    .filter(item => item.result === 'accepted')
    .map(item => item.body);
}

test('a message is delivered, and a platform gone drops it with a reason', async () => {
  const ctx = await team();
  const sent = await sendNote(ctx, ctx.planner, ctx.implementer, 'The tax rate changed.', 'note-1');

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const delivered = await copiesFor(ctx.deps, sent.message.id);
  const bodies = await deliveredBodies(ctx);

  expect(delivered.map(copy => copy.state)).toEqual(['delivered']);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain(sent.message.id);
  expect(bodies[0]).toContain('The tax rate changed.');

  ctx.simulated.controls.setSendResult('gone');

  const missed = await sendNote(
    ctx,
    ctx.planner,
    ctx.implementer,
    'This one will not land.',
    'note-2'
  );

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const dropped = await copiesFor(ctx.deps, missed.message.id);
  const events = await ctx.deps.store.events(defaultWorkspaceId, ctx.groupId);
  const drop = events.find(
    event => event.kind === 'message_dropped' && event.data.message_id === missed.message.id
  );

  expect(dropped.map(copy => copy.outcome_reason)).toEqual(['recipient_unknown_to_platform']);
  expect(drop?.task_id).toBe(ctx.implementer.task_id);
  expect(drop?.note).toBeNull();
  expect(JSON.stringify(drop?.data)).not.toContain('This one will not land.');
});

test('a worker that stops after the platform accepts delivers that message once more', async () => {
  const ctx = await team();
  const sent = await sendNote(
    ctx,
    ctx.implementer,
    ctx.planner,
    'Is the rate inclusive?',
    'crash-after'
  );

  await expect(
    drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1', halt: 'after_accept' })
  ).rejects.toBeInstanceOf(DeliveryStopped);

  const claimed = await copiesFor(ctx.deps, sent.message.id);

  expect(claimed.map(copy => copy.state)).toEqual(['claimed']);
  expect(ctx.simulated.sentMessages()).toHaveLength(1);
  expect(ctx.simulated.sentMessages()[0]?.body).toContain(sent.message.id);

  ctx.deps.clock.advance(claimMs);

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-2' });

  const bodies = ctx.simulated.sentMessages().map(item => item.body);
  const settled = await copiesFor(ctx.deps, sent.message.id);

  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain(sent.message.id);
  expect(bodies[1]).toContain(sent.message.id);
  expect(settled.map(copy => copy.state)).toEqual(['delivered']);
});

test('an end leaves a live claim for the worker to settle', async () => {
  const ctx = await team();
  const held = await sendNote(ctx, ctx.planner, ctx.implementer, 'Still in flight.', 'live-claim');
  const waiting = await sendNote(ctx, ctx.planner, ctx.implementer, 'Not claimed yet.', 'queued');

  await expect(
    drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1', halt: 'before_send' })
  ).rejects.toBeInstanceOf(DeliveryStopped);
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.implementer.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The member ended while the claim was live.',
  });

  expect((await copiesFor(ctx.deps, held.message.id)).map(copy => copy.state)).toEqual(['claimed']);
  expect((await copiesFor(ctx.deps, waiting.message.id))[0]?.outcome_reason).toBe(
    'recipient_ended'
  );

  ctx.deps.clock.advance(claimMs);
  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  expect((await copiesFor(ctx.deps, held.message.id))[0]?.outcome_reason).toBe('recipient_ended');
});

test('a worker that stops before the platform accepts loses nothing', async () => {
  const ctx = await team();
  const sent = await sendNote(ctx, ctx.implementer, ctx.planner, 'Still here.', 'crash-before');

  await expect(
    drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1', halt: 'before_send' })
  ).rejects.toBeInstanceOf(DeliveryStopped);

  expect(ctx.simulated.sentMessages()).toHaveLength(0);
  expect((await copiesFor(ctx.deps, sent.message.id)).map(copy => copy.state)).toEqual(['claimed']);

  ctx.deps.clock.advance(claimMs);

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-2' });

  const bodies = await deliveredBodies(ctx);
  const settled = await copiesFor(ctx.deps, sent.message.id);

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain(sent.message.id);
  expect(settled.map(copy => copy.state)).toEqual(['delivered']);
});

test('delivery stays in acceptance order for one recipient', async () => {
  const ctx = await team();
  const first = await sendNote(ctx, ctx.planner, ctx.implementer, 'First instruction.', 'order-1');
  const second = await sendNote(
    ctx,
    ctx.planner,
    ctx.implementer,
    'Second instruction.',
    'order-2'
  );

  ctx.simulated.controls.setSendResult('busy');
  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  expect(ctx.simulated.sentMessages().map(item => item.result)).toEqual(['busy']);
  expect((await copiesFor(ctx.deps, first.message.id))[0]?.state).toBe('queued');
  expect((await copiesFor(ctx.deps, first.message.id))[0]?.attempts).toBe(0);
  expect((await copiesFor(ctx.deps, second.message.id))[0]?.state).toBe('queued');
  expect(ctx.simulated.sentMessages().some(item => item.body.includes(second.message.id))).toBe(
    false
  );

  ctx.deps.clock.advance(30_000);
  ctx.simulated.controls.setSendResult('accepted');
  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const accepted = await deliveredBodies(ctx);

  expect(accepted).toHaveLength(2);
  expect(accepted[0]).toContain(first.message.id);
  expect(accepted[1]).toContain(second.message.id);
});

test('a child reaches a parent the platform has marked suspended', async () => {
  const ctx = await team();
  const ref = requirePresent(
    ctx.planner.platform_session_ref,
    'the planner has a platform session'
  );

  ctx.simulated.setSessionStatus(ref, 'suspended');

  const sent = await sendNote(ctx, ctx.implementer, ctx.planner, 'The interface is ready.', 'wake');

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const arrival = ctx.simulated.sentMessages()[0];
  const status = await ctx.simulated.adapter.readStatus(ctx.simulated.connection(), ref);

  expect(arrival?.statusAtSend).toBe('suspended');
  expect(arrival?.body).toContain(sent.message.id);
  expect(arrival?.result).toBe('accepted');
  expect(status.status).toBe('working');
});

test('the API refuses a message to a member that has already ended', async () => {
  const ctx = await httpTeam();
  const sent = await sendNote(ctx, ctx.planner, ctx.implementer, 'Before the end.', 'before-end');

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });
  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.implementer.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The work is done.',
  });

  const refused = await sendJson(
    ctx.server,
    'POST',
    '/v1/messages',
    { recipient_id: ctx.implementer.id, kind: 'note', body: 'Too late.' },
    { ...bearer(ctx.plannerToken), 'idempotency-key': 'too-late' }
  );
  const stored = await ctx.db.query<{ count: string }>('SELECT count(*) AS count FROM messages');
  const inbox = await sendJson(
    ctx.server,
    'GET',
    '/v1/messages',
    undefined,
    bearer(ctx.plannerToken)
  );

  expectStatus(refused, 409);
  expect(refused.body).toMatchObject({
    error: { code: 'recipient_not_available' },
  });
  expect(Number(stored.rows[0]?.count)).toBe(1);
  expect(inbox.body).toMatchObject({
    delivered_means:
      'Delivered means that the platform accepted the message. It does not mean that the session read it.',
  });
  expect(JSON.stringify(inbox.body)).toContain(sent.message.id);
  expect((await copiesFor(ctx.deps, sent.message.id))[0]?.state).toBe('delivered');
});

test('an answer clears the wait the question recorded', async () => {
  const ctx = await team();
  const question = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Which rounding mode should tax use?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'ask-1',
    bodyHash: 'ask-1',
  });
  const waiting = await waitsFor(ctx.deps, defaultWorkspaceId, ctx.groupId);
  const open = waiting.find(wait => wait.question_id === question.message.id);

  expect(open?.waiting_session_id).toBe(ctx.planner.id);
  expect(open?.awaited_session_id).toBe(ctx.implementer.id);
  expect(open?.cleared_at).toBeNull();
  expect(Date.parse(requirePresent(open?.deadline_at, 'a question records a deadline'))).toBe(
    ctx.deps.clock.now().getTime() + 5 * 60 * 1000
  );

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.implementer.id },
    kind: 'answer',
    body: 'Half away from zero.',
    audience: 'one',
    recipientId: ctx.planner.id,
    inReplyTo: question.message.id,
    idempotencyKey: 'answer-1',
    bodyHash: 'answer-1',
  });

  const cleared = (await waitsFor(ctx.deps, defaultWorkspaceId, ctx.groupId)).find(
    wait => wait.question_id === question.message.id
  );

  expect(cleared?.cleared_at).toBe(ctx.deps.clock.now().toISOString());
});

test('a rate-limited platform pauses delivery and busy does not count as an attempt', async () => {
  const ctx = await team();

  ctx.simulated.controls.setSendResult('rate_limited');

  const blocked = await sendNote(ctx, ctx.planner, ctx.implementer, 'Hold this.', 'limited');

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const other = await sendNote(ctx, ctx.implementer, ctx.planner, 'And this.', 'other');

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  expect(ctx.simulated.sentMessages().map(item => item.result)).toEqual(['rate_limited']);
  expect((await copiesFor(ctx.deps, blocked.message.id))[0]?.state).toBe('queued');
  expect((await copiesFor(ctx.deps, other.message.id))[0]?.state).toBe('queued');

  ctx.deps.clock.advance(30_000);
  ctx.simulated.controls.setSendResult('accepted');
  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  expect((await copiesFor(ctx.deps, blocked.message.id))[0]?.state).toBe('delivered');
  expect((await copiesFor(ctx.deps, other.message.id))[0]?.state).toBe('delivered');
});

test('the sender limits refuse the eleventh message and the sixth open question', async () => {
  const ctx = await team();

  for (let index = 0; index < 10; index += 1) {
    await sendNote(ctx, ctx.planner, ctx.implementer, `Note ${index}`, `limit-${index}`);
  }

  await expect(
    sendNote(ctx, ctx.planner, ctx.implementer, 'One too many.', 'limit-10')
  ).rejects.toMatchObject({ code: 'rate_limited' });

  ctx.deps.clock.advance(60_000);

  for (let index = 0; index < 5; index += 1) {
    await sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.planner.id },
      kind: 'question',
      body: `Question ${index}`,
      audience: 'one',
      recipientId: ctx.implementer.id,
      idempotencyKey: `open-${index}`,
      bodyHash: `open-${index}`,
    });
  }

  await expect(
    sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.planner.id },
      kind: 'question',
      body: 'A sixth question.',
      audience: 'one',
      recipientId: ctx.implementer.id,
      idempotencyKey: 'open-5',
      bodyHash: 'open-5',
    })
  ).rejects.toMatchObject({ code: 'rate_limited' });
});

test('the planner can address every member only three times in ten minutes', async () => {
  const ctx = await team();

  for (let index = 0; index < 3; index += 1) {
    const sent = await sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.planner.id },
      kind: 'note',
      body: `Everyone ${index}`,
      audience: 'all',
      idempotencyKey: `all-${index}`,
      bodyHash: `all-${index}`,
    });

    expect(sent.copies.map(copy => copy.recipient_id)).toEqual([ctx.implementer.id]);
  }

  await expect(
    sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.planner.id },
      kind: 'note',
      body: 'A fourth broadcast.',
      audience: 'all',
      idempotencyKey: 'all-3',
      bodyHash: 'all-3',
    })
  ).rejects.toMatchObject({ code: 'rate_limited' });

  await expect(
    sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.implementer.id },
      kind: 'note',
      body: 'Not the planner.',
      audience: 'all',
      idempotencyKey: 'all-child',
      bodyHash: 'all-child',
    })
  ).rejects.toMatchObject({ code: 'policy_denied' });
});

test('a broadcast stores nothing when any member cannot receive', async () => {
  const ctx = await team();
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.groupId,
    taskId: ctx.root.id,
    role: 'challenger',
    instructions: 'Question the tax change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'start-challenger',
    bodyHash: 'start-challenger',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');

  await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.implementer.id,
    actor: { kind: 'session', sessionId: ctx.planner.id },
    reason: 'The work is done.',
  });

  const before = await ctx.db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM messages'
  );

  await expect(
    sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.planner.id },
      kind: 'note',
      body: 'Everyone who is still here.',
      audience: 'all',
      idempotencyKey: 'all-or-nothing',
      bodyHash: 'all-or-nothing',
    })
  ).rejects.toMatchObject({ code: 'recipient_not_available' });

  const after = await ctx.db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM messages'
  );

  expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
});

test('a token-shaped string is replaced before the body is stored or delivered', async () => {
  const ctx = await team();
  const secret = `ses_${'A'.repeat(43)}`;
  const operator = `opk_${'B'.repeat(43)}`;
  const person = `per_${'C'.repeat(43)}`;
  const sent = await sendNote(
    ctx,
    ctx.planner,
    ctx.implementer,
    `Use ${secret} and ${operator} if you must. Not ${person}.`,
    'redact'
  );

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const body = ctx.simulated.sentMessages()[0]?.body ?? '';

  expect(sent.message.body).toContain(credentialMarker);
  expect(sent.message.body).not.toContain(secret);
  expect(sent.message.body).not.toContain(operator);
  expect(sent.message.body).toContain(person);
  expect(body).toContain(credentialMarker);
  expect(body).not.toContain(secret);
  expect(body).not.toContain(operator);
  expect(body).toContain(person);
  expect(body).toContain(ctx.planner.id);
});

test('a copy that has waited 24 hours is dropped as expired', async () => {
  const ctx = await team();
  const sent = await sendNote(ctx, ctx.planner, ctx.implementer, 'Still queued.', 'stale');

  ctx.deps.clock.advance(dayMs);

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const copies = await copiesFor(ctx.deps, sent.message.id);

  expect(copies.map(copy => copy.outcome_reason)).toEqual(['expired']);
  expect(ctx.simulated.sentMessages()).toHaveLength(0);
});

test('the same owner key and body on another group does not replay the first send', async () => {
  const ctx = await httpTeam();
  const second = await openGroup(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: ctx.admin.id,
    ...checkoutGroup,
    name: 'Payments',
    connectionId: ctx.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'open-second',
    bodyHash: 'open-second',
  });
  const body = { all: true, kind: 'note', body: 'Same words.' };
  const headers = { ...bearer(ctx.creatorSecret), 'idempotency-key': 'owner-same' };
  const first = await sendJson(
    ctx.server,
    'POST',
    `/v1/groups/${ctx.groupId}/messages`,
    body,
    headers
  );
  const other = await sendJson(
    ctx.server,
    'POST',
    `/v1/groups/${second.group.id}/messages`,
    body,
    headers
  );

  expectStatus(first, 201);
  expect(other.status).toBe(409);
  expect(other.body).toMatchObject({ error: { code: 'idempotency_conflict' } });
});

test('two identical sends in flight return the same message', async () => {
  const ctx = await team();
  const input = {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session' as const, sessionId: ctx.planner.id },
    kind: 'note' as const,
    body: 'Once.',
    audience: 'one' as const,
    recipientId: ctx.implementer.id,
    idempotencyKey: 'twice',
    bodyHash: 'twice',
  };
  const [first, second] = await Promise.all([
    sendMessage(ctx.deps, input),
    sendMessage(ctx.deps, input),
  ]);

  expect(first.message.id).toBe(second.message.id);
});

test('a wait deadline is taken after the send locks', async () => {
  const ctx = await team();
  const store = ctx.deps.store;
  const transact = store.transact.bind(store);
  const stillEarly = new Set(['lockGroup', 'lockSession']);

  store.transact = work =>
    transact(async tx => {
      const watched = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== 'lockGroup' && prop !== 'lockSession') {
            const value = Reflect.get(target, prop, receiver);

            return typeof value === 'function' ? value.bind(target) : value;
          }

          return async (...args: unknown[]) => {
            const method = Reflect.get(target, prop, receiver) as (
              ...methodArgs: unknown[]
            ) => Promise<unknown>;
            const locked = await method.apply(target, args);

            if (stillEarly.delete(String(prop))) ctx.deps.clock.advance(6 * 60 * 1000);

            return locked;
          };
        },
      });

      return work(watched);
    });

  const sent = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Still in time?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'deadline-after-lock',
    bodyHash: 'deadline-after-lock',
  });
  const wait = requirePresent(sent.wait, 'the question should record a wait');

  expect(Date.parse(wait.deadline_at)).toBeGreaterThanOrEqual(ctx.deps.clock.now().getTime());
});

test('the inbox stops at the same limit as the mail log', async () => {
  const ctx = await team();
  const count = mailLogLimit + 1;

  await ctx.db.query(
    `INSERT INTO messages (
       id, workspace_id, group_id, sender_kind, sender_id, sender_role, sender_task_id,
       kind, audience, body, idempotency_key, created_at
     )
     SELECT 'msg_' || lpad(n::text, 26, '0'), $1, $2, 'session', $3, 'planner', $4,
            'note', 'one', 'bulk', 'bulk-' || n::text,
            timestamp '2026-01-01 00:00:00+00' + (n * interval '1 second')
     FROM generate_series(1, $5::int) AS n`,
    [defaultWorkspaceId, ctx.groupId, ctx.planner.id, ctx.planner.task_id, count]
  );

  const inbox = await listInbox(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.groupId,
    sessionId: ctx.planner.id,
    kind: null,
    unanswered: false,
  });
  const newest = `msg_${String(count).padStart(26, '0')}`;
  const oldest = `msg_${'1'.padStart(26, '0')}`;

  expect(inbox.messages).toHaveLength(mailLogLimit);
  expect(`${inbox.messages[0]?.id ?? ''}`).toBe(newest);
  expect(inbox.messages.map(message => `${message.id}`)).not.toContain(oldest);
});

test('an unanswered inbox keeps a broadcast question until that reader answers', async () => {
  const ctx = await team();
  const started = await startSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.groupId,
    taskId: ctx.root.id,
    role: 'challenger',
    instructions: 'Question the tax change.',
    actor: { kind: 'session', sessionId: ctx.planner.id },
    idempotencyKey: 'start-reader',
    bodyHash: 'start-reader',
    replacementOf: null,
  });

  expect(started.outcome).toBe('live');

  if (started.outcome !== 'live') throw new Error('challenger did not start');

  const question = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Which rounding mode?',
    audience: 'all',
    idempotencyKey: 'ask-all',
    bodyHash: 'ask-all',
  });

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.implementer.id },
    kind: 'answer',
    body: 'Half away from zero.',
    audience: 'one',
    recipientId: ctx.planner.id,
    inReplyTo: question.message.id,
    idempotencyKey: 'answer-all',
    bodyHash: 'answer-all',
  });

  const stillOpen = await listInbox(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.groupId,
    sessionId: started.session.id,
    kind: null,
    unanswered: true,
  });
  const answered = await listInbox(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    groupId: ctx.groupId,
    sessionId: ctx.implementer.id,
    kind: null,
    unanswered: true,
  });

  expect(stillOpen.messages.map(message => message.id)).toContain(question.message.id);
  expect(answered.messages.map(message => message.id)).not.toContain(question.message.id);
});

test('a recorded wait locks the group before either session', async () => {
  const ctx = await team();
  const orders = watchTransactions(ctx.deps.store);

  await recordWait(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    awaitedId: ctx.implementer.id,
    seconds: 60,
    questionId: null,
  });

  const order = orders.find(item => item.includes('session'));

  expect(order).toContain('group');
  expect(order?.indexOf('group')).toBeLessThan(order?.indexOf('session') ?? -1);
});

test('a question does not name a fixed five minutes', async () => {
  const ctx = await team();

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Which rounding mode?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    waitSeconds: 60,
    idempotencyKey: 'ask-sixty',
    bodyHash: 'ask-sixty',
  });
  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const text = ctx.simulated.sentMessages()[0]?.body ?? '';

  expect(text).toContain('A partial answer is acceptable.');
  expect(text).not.toContain('five minutes');
});

test('an owner send locks the workspace before the group', async () => {
  const ctx = await team();
  const orders = watchTransactions(ctx.deps.store);

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'person', personId: ctx.admin.id, administrator: false },
    kind: 'note',
    body: 'From the owner.',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'owner-lock',
    bodyHash: 'owner-lock',
  });

  const order = orders.find(item => item.includes('group'));

  expect(order).toContain('workspace');
  expect(order?.indexOf('workspace')).toBeLessThan(order?.indexOf('group') ?? -1);
});

test('a retry returns the wait a note recorded', async () => {
  const ctx = await team();
  const input = {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session' as const, sessionId: ctx.planner.id },
    kind: 'note' as const,
    body: 'Hold for this.',
    audience: 'one' as const,
    recipientId: ctx.implementer.id,
    recordWait: true,
    waitSeconds: 60,
    idempotencyKey: 'noted-wait',
    bodyHash: 'noted-wait',
  };
  const first = await sendMessage(ctx.deps, input);
  const again = await sendMessage(ctx.deps, input);
  const firstWait = requirePresent(first.wait, 'the first note should record a wait');
  const againWait = requirePresent(again.wait, 'the retry should return that wait');

  expect(againWait.id).toBe(firstWait.id);
});

test('a retry of a question that stored no wait does not return a later wait', async () => {
  const ctx = await team();
  const question = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Which rounding mode?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    recordWait: false,
    idempotencyKey: 'ask-no-wait',
    bodyHash: 'ask-no-wait',
  });

  expect(question.wait).toBeNull();

  const later = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.implementer.id },
    kind: 'note',
    body: 'I am waiting on that question.',
    audience: 'one',
    recipientId: ctx.planner.id,
    inReplyTo: question.message.id,
    recordWait: true,
    idempotencyKey: 'note-waits-on-question',
    bodyHash: 'note-waits-on-question',
  });

  expect(later.wait?.question_id).toBe(question.message.id);

  const again = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Which rounding mode?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    recordWait: false,
    idempotencyKey: 'ask-no-wait',
    bodyHash: 'ask-no-wait',
  });

  expect(again.message.id).toBe(question.message.id);
  expect(again.wait).toBeNull();
});

test('a duplicate visible only after the sender lock is not rate limited', async () => {
  const ctx = await team();
  const input = {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session' as const, sessionId: ctx.planner.id },
    kind: 'note' as const,
    body: 'The tenth.',
    audience: 'one' as const,
    recipientId: ctx.implementer.id,
    idempotencyKey: 'tenth',
    bodyHash: 'tenth',
  };
  const stored = await sendMessage(ctx.deps, input);

  hideReplayUntilLocked(ctx.deps.store);

  const again = await sendMessage(ctx.deps, input);

  expect(again.message.id).toBe(stored.message.id);
});

test('a duplicate owner send visible only after the group lock is not rate limited', async () => {
  const ctx = await team();
  const input = {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'person' as const, personId: ctx.admin.id, administrator: false },
    kind: 'note' as const,
    body: 'The tenth from the owner.',
    audience: 'one' as const,
    recipientId: ctx.implementer.id,
    idempotencyKey: 'owner-tenth',
    bodyHash: 'owner-tenth',
  };
  const stored = await sendMessage(ctx.deps, input);

  hideReplayUntilLocked(ctx.deps.store);

  const again = await sendMessage(ctx.deps, input);

  expect(again.message.id).toBe(stored.message.id);
});

test('a send locks the group before either session', async () => {
  const ctx = await team();
  const orders = watchTransactions(ctx.deps.store);

  await sendNote(ctx, ctx.planner, ctx.implementer, 'Lock the group first.', 'lock-order');

  const order = orders.find(item => item.includes('group') || item.includes('session'));

  expect(order).toContain('group');
  expect(order?.indexOf('group')).toBeLessThan(order?.indexOf('session') ?? -1);
});

test('a send locks the sender tasks before the sender session', async () => {
  const ctx = await team();
  const orders = watchTransactions(ctx.deps.store);

  await sendNote(ctx, ctx.implementer, ctx.planner, 'Lock the tasks first.', 'task-lock-order');

  expect(tasksLockedBeforeTheFirstSession(orders)).toBeGreaterThanOrEqual(2);
});

test('a recorded wait locks the sender tasks before the sender session', async () => {
  const ctx = await team();
  const orders = watchTransactions(ctx.deps.store);

  await recordWait(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.implementer.id,
    awaitedId: ctx.planner.id,
    seconds: 60,
    questionId: null,
  });

  expect(tasksLockedBeforeTheFirstSession(orders)).toBeGreaterThanOrEqual(2);
});

test('a drop locks the group before the recipient and the event', async () => {
  const ctx = await team();

  ctx.simulated.controls.setSendResult('gone');
  await sendNote(ctx, ctx.planner, ctx.implementer, 'This one will not land.', 'drop-lock');

  const orders = watchTransactions(ctx.deps.store);

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const order = orders.find(item => item.includes('sequence'));

  expect(order).toContain('group');
  expect(order?.indexOf('group')).toBeLessThan(order?.indexOf('session') ?? -1);
  expect(order?.indexOf('group')).toBeLessThan(order?.indexOf('sequence') ?? -1);
});

test('an owner message does not name a person in a session command', async () => {
  const ctx = await team();

  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'person', personId: ctx.admin.id, administrator: false },
    kind: 'note',
    body: 'From the owner.',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'owner-note',
    bodyHash: 'owner-note',
  });
  await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'person', personId: ctx.admin.id, administrator: false },
    kind: 'question',
    body: 'Which file?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'owner-question',
    bodyHash: 'owner-question',
  });
  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const texts = ctx.simulated.sentMessages().map(item => item.body);

  expect(texts).toHaveLength(2);

  for (const text of texts) {
    expect(text).not.toContain(`--to ${ctx.admin.id}`);
    expect(text).not.toContain('hivemind send');
    expect(text).not.toContain('hivemind answer');
  }
});

test('an owner can address a member without repeating the group id', async () => {
  const ctx = await team();
  const sent = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'person', personId: ctx.admin.id, administrator: false },
    kind: 'note',
    body: 'From the owner.',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'owner-direct',
    bodyHash: 'owner-direct',
  });

  expect(sent.copies.map(copy => copy.recipient_id)).toEqual([ctx.implementer.id]);
});

test('a role address cannot select the sender', async () => {
  const ctx = await team();

  await expect(
    sendMessage(ctx.deps, {
      workspaceId: defaultWorkspaceId,
      sender: { kind: 'session', sessionId: ctx.planner.id },
      kind: 'note',
      body: 'To myself by role.',
      audience: 'one',
      role: 'planner',
      taskId: ctx.planner.task_id,
      idempotencyKey: 'self-role',
      bodyHash: 'self-role',
    })
  ).rejects.toMatchObject({ code: 'recipient_not_available' });
});

test('a copy that expires while an earlier send is in flight is not delivered', async () => {
  const ctx = await team();
  const original = ctx.simulated.adapter;

  replaceAdapter(ctx, {
    ...original,
    async send(connection, ref, body) {
      const result = await original.send(connection, ref, body);

      ctx.deps.clock.advance(dayMs);

      return result;
    },
  });

  const first = await sendNote(ctx, ctx.planner, ctx.implementer, 'Still in time.', 'age-1');
  const second = await sendNote(ctx, ctx.planner, ctx.implementer, 'Past the day.', 'age-2');

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  expect(ctx.simulated.sentMessages().map(item => item.body)).toEqual([
    expect.stringContaining(first.message.id),
  ]);
  expect((await copiesFor(ctx.deps, second.message.id))[0]?.outcome_reason).toBe('expired');
});

test('the question header names the command that answers it', async () => {
  const ctx = await team();
  const question = await sendMessage(ctx.deps, {
    workspaceId: defaultWorkspaceId,
    sender: { kind: 'session', sessionId: ctx.planner.id },
    kind: 'question',
    body: 'Which rounding mode?',
    audience: 'one',
    recipientId: ctx.implementer.id,
    idempotencyKey: 'ask-command',
    bodyHash: 'ask-command',
  });

  await drainOutbox(ctx.deps, ctx.platforms, { workerId: 'worker-1' });

  const text = ctx.simulated.sentMessages()[0]?.body ?? '';

  expect(text).toContain(`hivemind answer --message ${question.message.id} --to ${ctx.planner.id}`);
  expect(text).not.toContain(`hivemind answer --message ${question.message.id}\n`);
});

test('the send command posts the message for the session', async () => {
  let path = '';
  let payload = '';
  const io: Io = {
    args: ['send', '--to', 'ses_0123456789ABCDEFGHJKMNPQRS', '--body', 'Hello.'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => undefined,
    stderr: () => undefined,
    fetch: (async (input, init) => {
      path = String(input);
      payload = String(init?.body ?? '');

      return new Response(JSON.stringify({ message: { id: 'msg_x' } }), { status: 200 });
    }) as typeof fetch,
    sleep: async () => undefined,
  };

  expect(await runHivemind(io)).toBe(0);
  expect(path).toBe('http://127.0.0.1:9/v1/messages');
  expect(JSON.parse(payload)).toMatchObject({
    recipient_id: 'ses_0123456789ABCDEFGHJKMNPQRS',
    kind: 'note',
    body: 'Hello.',
  });
});

test('a passed --wait records a wait, and ask records one without the flag', async () => {
  const cases = [
    {
      args: ['send', '--to', 'ses_0123456789ABCDEFGHJKMNPQRS', '--body', 'Hello.', '--wait', '60'],
      record: true,
      seconds: 60,
    },
    {
      args: [
        'answer',
        '--to',
        'ses_0123456789ABCDEFGHJKMNPQRS',
        '--message',
        'msg_x',
        '--body',
        'Hello.',
        '--wait',
        '30',
      ],
      record: true,
      seconds: 30,
    },
    {
      args: ['relay', '--body', 'Hello.', '--wait', '15'],
      record: true,
      seconds: 15,
    },
    {
      args: ['ask', '--to', 'ses_0123456789ABCDEFGHJKMNPQRS', '--body', 'Hello.'],
      record: true,
      seconds: undefined,
    },
  ];

  for (const item of cases) {
    let payload = '';
    const io: Io = {
      args: item.args,
      env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
      stdout: () => undefined,
      stderr: () => undefined,
      fetch: (async (_input, init) => {
        payload = String(init?.body ?? '');

        return new Response(JSON.stringify({ message: { id: 'msg_x' } }), { status: 200 });
      }) as typeof fetch,
      sleep: async () => undefined,
    };

    expect(await runHivemind(io)).toBe(0);

    const body = JSON.parse(payload) as { record_wait?: boolean; wait_seconds?: number };

    expect(body.record_wait).toBe(item.record);
    expect(body.wait_seconds).toBe(item.seconds);
  }
});

test('send, ask, answer, and relay say a busy recipient stays queued', async () => {
  const commands = [
    ['send', '--to', 'ses_0123456789ABCDEFGHJKMNPQRS', '--body', 'Hello.'],
    ['ask', '--to', 'ses_0123456789ABCDEFGHJKMNPQRS', '--body', 'Hello.'],
    ['answer', '--to', 'ses_0123456789ABCDEFGHJKMNPQRS', '--message', 'msg_x', '--body', 'Hello.'],
    ['relay', '--body', 'Hello.'],
  ];

  for (const args of commands) {
    const lines: string[] = [];
    const io: Io = {
      args,
      env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
      stdout: line => lines.push(line),
      stderr: () => undefined,
      fetch: (async (_input, _init) =>
        new Response(JSON.stringify({ message: { id: 'msg_x' } }), {
          status: 200,
        })) as typeof fetch,
      sleep: async () => undefined,
    };

    expect(await runHivemind(io)).toBe(0);
    expect(lines.join('\n')).toContain(
      'A recipient who is busy does not bounce the message: it stays queued and is tried again. Do not send it again.'
    );
  }
});

function hideReplayUntilLocked(store: Service['deps']['store']): void {
  let locked = false;
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const watched = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'findIdempotency') {
            return async (...args: unknown[]) => {
              if (!locked) return null;

              return call(target, prop, receiver, args);
            };
          }

          if (prop === 'lockSession' || prop === 'lockGroup') {
            return async (...args: unknown[]) => {
              const result = await call(target, prop, receiver, args);

              locked = true;

              return result;
            };
          }

          if (prop === 'countSenderMessages') return async () => senderLimit;

          const value = Reflect.get(target, prop, receiver);

          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      return work(watched);
    });
}

function call(
  target: UnitOfWork,
  prop: string | symbol,
  receiver: UnitOfWork,
  args: unknown[]
): Promise<unknown> {
  const method = Reflect.get(target, prop, receiver) as (
    ...methodArgs: unknown[]
  ) => Promise<unknown>;

  return method.apply(target, args);
}

function tasksLockedBeforeTheFirstSession(orders: string[][]): number {
  const order = requirePresent(
    orders.find(item => item.includes('session')),
    'the transaction should lock a session'
  );

  return order.slice(0, order.indexOf('session')).filter(name => name === 'task').length;
}

function watchTransactions(store: Service['deps']['store']): string[][] {
  const orders: string[][] = [];
  const transact = store.transact.bind(store);

  store.transact = work =>
    transact(async tx => {
      const order: string[] = [];

      orders.push(order);

      return work(watchSendLocks(tx, order));
    });

  return orders;
}

function watchSendLocks(tx: UnitOfWork, order: string[]): UnitOfWork {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (
        prop !== 'lockWorkspace' &&
        prop !== 'lockGroup' &&
        prop !== 'lockTask' &&
        prop !== 'lockSession' &&
        prop !== 'nextSequence'
      ) {
        const value = Reflect.get(target, prop, receiver);

        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        order.push(lockName(prop));

        const method = Reflect.get(target, prop, receiver) as (
          ...methodArgs: unknown[]
        ) => Promise<unknown>;

        return method.apply(target, args);
      };
    },
  });
}

function lockName(
  prop: 'lockWorkspace' | 'lockGroup' | 'lockTask' | 'lockSession' | 'nextSequence'
): string {
  if (prop === 'lockWorkspace') return 'workspace';
  if (prop === 'lockGroup') return 'group';
  if (prop === 'lockTask') return 'task';
  if (prop === 'lockSession') return 'session';

  return 'sequence';
}
