import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { ServiceDeps } from '@/core/deps.ts';
import { openInstallation } from '@/core/installation.ts';
import { HivemindError } from '@/domain/errors.ts';
import { createIds, defaultWorkspaceId, requireGroupId } from '@/domain/ids.ts';
import { startHttp } from '@/http/server.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import { manualClock } from '@/ports/clock.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPgliteStore } from '@/storage/postgres/store.ts';

const address = [{ label: 'pull request', kind: 'address', value: 'https://example.com/pr/1' }];
const check = [{ label: 'check', kind: 'text', value: 'the suite passed' }];

async function boot(options?: { secretInjection?: boolean }) {
  const db = new PGlite();
  await db.waitReady;
  const clock = manualClock(new Date('2026-11-16T00:00:00.000Z'));
  const store = openPgliteStore(db);
  const deps: ServiceDeps = {
    store,
    clock,
    random: systemRandom,
    ids: createIds(clock, systemRandom),
    responseKey: 'test-response-key',
  };

  await store.migrate();
  const installation = await openInstallation(deps);
  const connectionId = deps.ids.connection();
  const simulated = createSimulatedPlatform(connectionId);

  if (options?.secretInjection === false) simulated.drop('secret_injection');

  const platforms: Platforms = {
    require(id) {
      if (id !== connectionId) {
        throw new HivemindError('not_found', 'No connection with that identifier exists.');
      }

      return { adapter: simulated.adapter, connection: simulated.connection() };
    },
  };
  const server = await startHttp({ deps, platforms, connectionId });

  return { db, deps, simulated, server, bootstrap: installation.bootstrapSecret };
}

async function json(
  server: { url: string },
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;

  return { status: response.status, body: parsed };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error as { code?: string } | undefined;

  return error?.code ?? '';
}

async function creatorKey(ctx: Awaited<ReturnType<typeof boot>>): Promise<string> {
  const admin = await json(
    ctx.server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    { authorization: `Bearer ${ctx.bootstrap}` }
  );

  expect(admin.status).toBe(201);

  const key = await json(
    ctx.server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'creator', role: 'creator' },
    { authorization: `Bearer ${ctx.bootstrap}` }
  );

  expect(key.status).toBe(201);

  return String(key.body.secret);
}

test('a numeric key expiry is refused', async () => {
  const ctx = await boot();
  const created = await json(
    ctx.server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    { authorization: `Bearer ${ctx.bootstrap}` }
  );

  expect(created.status).toBe(201);

  const refused = await json(
    ctx.server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'creator', role: 'creator', expires_at: 1 },
    { authorization: `Bearer ${ctx.bootstrap}` }
  );
  const absent = await json(
    ctx.server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'later', role: 'creator', expires_at: null },
    { authorization: `Bearer ${ctx.bootstrap}` }
  );

  expect(refused.status).toBe(422);
  expect(errorCode(refused.body)).toBe('validation_failed');
  expect(absent.status).toBe(201);
  expect(typeof absent.body.secret).toBe('string');
  ctx.server.stop();
});

test('a lowercase bearer scheme is accepted', async () => {
  const ctx = await boot();
  const created = await json(
    ctx.server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    { authorization: `bearer ${ctx.bootstrap}` }
  );

  expect(created.status).toBe(201);
  ctx.server.stop();
});

test('a body over 256 KiB is refused before it is handled', async () => {
  const ctx = await boot();
  const response = await fetch(`${ctx.server.url}/healthz`, {
    method: 'POST',
    body: 'x'.repeat(256 * 1024 + 1),
  });

  expect(response.status).toBe(413);
  expect(await response.text()).toBe('');
  ctx.server.stop();
});

test('a member can read the task history', async () => {
  const ctx = await boot({ secretInjection: false });
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work and start the team.',
      verification_mode: 'before_merge',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'history-group' }
  );
  const root = created.body.root as { id: string };
  const planner = created.body.session as { id: string };
  const token = await enrollFromPrompt(ctx, planner.id);
  const history = await json(ctx.server, 'GET', `/v1/tasks/${root.id}/events`, undefined, {
    authorization: `Bearer ${token}`,
  });
  const events = history.body.events as { task_id?: string; kind?: string }[];

  expect(created.status).toBe(201);
  expect(history.status).toBe(200);
  expect(events.some(event => event.task_id === root.id && event.kind === 'created')).toBe(true);
  ctx.server.stop();
});

test('a scripted group reaches done through HTTP without a platform call on transition', async () => {
  const ctx = await boot({ secretInjection: false });
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work and start the team.',
      verification_mode: 'before_merge',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'group-1' }
  );

  expect(created.status).toBe(201);

  const group = created.body.group as { id: string };
  const rootCreated = created.body.root as { id: string };
  const planner = created.body.session as { id: string };
  const plannerToken = await enrollFromPrompt(ctx, planner.id);

  await move(ctx, plannerToken, rootCreated.id, 'analyzing', 'The plan is underway.');

  const child = await json(
    ctx.server,
    'POST',
    '/v1/tasks',
    {
      title: 'Hide the tax rules',
      description: 'Move tax calculation behind an interface.',
    },
    { authorization: `Bearer ${plannerToken}`, 'idempotency-key': 'task-1' }
  );

  expect(child.status).toBe(201);

  const task = child.body.task as { id: string; version: number };
  const challenger = await startMember(
    ctx,
    plannerToken,
    'challenger',
    rootCreated.id,
    'Challenge the plan.'
  );
  const challengerToken = await enrollFromPrompt(ctx, challenger.id);

  await json(ctx.server, 'GET', '/v1/session', undefined, {
    authorization: `Bearer ${challengerToken}`,
  });

  await move(ctx, plannerToken, rootCreated.id, 'implementing', 'A child task exists.');

  const implementer = await startMember(
    ctx,
    plannerToken,
    'implementer',
    task.id,
    'Write the interface.'
  );
  const implementerToken = await enrollFromPrompt(ctx, implementer.id);
  const implementing = await taskOf(ctx, implementerToken, task.id);

  await move(
    ctx,
    implementerToken,
    task.id,
    'implementing',
    'Work has started.',
    implementing.version
  );

  const reviewer = await startMember(
    ctx,
    implementerToken,
    'reviewer',
    task.id,
    'Review the change.'
  );
  const reviewerToken = await enrollFromPrompt(ctx, reviewer.id);
  const inReview = await taskOf(ctx, implementerToken, task.id);
  const callsBefore = ctx.simulated.calls().length;

  await move(
    ctx,
    implementerToken,
    task.id,
    'in_review',
    'The pull request is ready.',
    inReview.version,
    address
  );

  expect(ctx.simulated.calls().length).toBe(callsBefore);

  const approvedFrom = await taskOf(ctx, reviewerToken, task.id);

  await move(
    ctx,
    reviewerToken,
    task.id,
    'approved',
    'The review approves the change.',
    approvedFrom.version,
    address
  );

  const verifier = await startMember(ctx, reviewerToken, 'verifier', task.id, 'Check the branch.');
  const verifierToken = await enrollFromPrompt(ctx, verifier.id);
  const verifyFrom = await taskOf(ctx, reviewerToken, task.id);

  await move(
    ctx,
    reviewerToken,
    task.id,
    'verifying_before_merge',
    'Verification starts before merge.',
    verifyFrom.version
  );
  const mergingFrom = await taskOf(ctx, verifierToken, task.id);

  await move(
    ctx,
    verifierToken,
    task.id,
    'merging',
    'The check passed.',
    mergingFrom.version,
    check
  );

  const doneFrom = await taskOf(ctx, reviewerToken, task.id);

  await move(
    ctx,
    reviewerToken,
    task.id,
    'done',
    'The pull request merged.',
    doneFrom.version,
    address
  );

  const rootAfter = await rootTask(ctx, plannerToken);
  const members = await json(ctx.server, 'GET', '/v1/sessions', undefined, {
    authorization: `Bearer ${plannerToken}`,
  });
  const roles = ((members.body.sessions as { role: string }[]) ?? []).map(session => session.role);

  expect(rootAfter.state).toBe('done');
  expect(roles.sort()).toEqual(
    ['challenger', 'implementer', 'planner', 'reviewer', 'verifier'].sort()
  );
  expect(group.id.startsWith('grp_')).toBe(true);

  ctx.server.stop();
});

test('the session routes return the named error codes', async () => {
  const ctx = await boot();
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'errors-group' }
  );
  const root = created.body.root as { id: string; version: number };
  const planner = created.body.session as { id: string };
  const token = ctx.simulated.secretFor(planner.id);

  if (token === null) throw new Error('the planner token should be injected');

  const missing = await json(ctx.server, 'GET', '/v1/session');

  expect(missing.status).toBe(401);
  expect(errorCode(missing.body)).toBe('unauthenticated');

  await move(ctx, token, root.id, 'analyzing', 'The plan is underway.', root.version);

  const child = await json(
    ctx.server,
    'POST',
    '/v1/tasks',
    { title: 'Hide the tax rules', description: 'Move tax calculation behind an interface.' },
    { authorization: `Bearer ${token}`, 'idempotency-key': 'errors-task' }
  );
  const task = child.body.task as { id: string; version: number };
  const challenger = await startMember(ctx, token, 'challenger', root.id, 'Read the plan.');
  const challengerToken = ctx.simulated.secretFor(challenger.id);

  if (challengerToken === null) throw new Error('the challenger token should be injected');

  const denied = await json(
    ctx.server,
    'POST',
    '/v1/sessions',
    { role: 'implementer', task_id: task.id, instructions: 'A challenger cannot start this.' },
    { authorization: `Bearer ${challengerToken}`, 'idempotency-key': 'denied' }
  );

  expect(denied.status).toBe(403);
  expect(errorCode(denied.body)).toBe('policy_denied');

  await json(
    ctx.server,
    'POST',
    '/v1/session/release',
    {},
    {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'errors-release',
    }
  );

  const inactive = await json(
    ctx.server,
    'POST',
    '/v1/sessions',
    { role: 'implementer', task_id: task.id, instructions: 'A released planner cannot start.' },
    { authorization: `Bearer ${token}`, 'idempotency-key': 'inactive' }
  );

  expect(inactive.status).toBe(403);
  expect(errorCode(inactive.body)).toBe('session_not_active');

  await json(
    ctx.server,
    'POST',
    '/v1/session/resume',
    {},
    {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'errors-resume',
    }
  );

  const implementer = await startMember(ctx, token, 'implementer', task.id, 'Write the change.');
  const implementerToken = ctx.simulated.secretFor(implementer.id);

  if (implementerToken === null) throw new Error('the implementer token should be injected');

  const badTransition = await json(
    ctx.server,
    'POST',
    `/v1/tasks/${task.id}/transitions`,
    {
      to: 'approved',
      expected_version: task.version,
      note: 'This skip is not in the table.',
      evidence: [],
    },
    { authorization: `Bearer ${implementerToken}`, 'idempotency-key': 'bad-transition' }
  );

  expect(badTransition.status).toBe(409);
  expect(errorCode(badTransition.body)).toBe('invalid_transition');

  const current = await taskOf(ctx, implementerToken, task.id);

  await move(ctx, implementerToken, task.id, 'implementing', 'Work has started.', current.version);

  const reviewing = await taskOf(ctx, implementerToken, task.id);
  const missingEvidence = await json(
    ctx.server,
    'POST',
    `/v1/tasks/${task.id}/transitions`,
    {
      to: 'in_review',
      expected_version: reviewing.version,
      note: 'The pull request exists.',
      evidence: [],
    },
    { authorization: `Bearer ${implementerToken}`, 'idempotency-key': 'missing-evidence' }
  );

  expect(missingEvidence.status).toBe(422);
  expect(errorCode(missingEvidence.body)).toBe('evidence_required');

  const stale = await json(
    ctx.server,
    'POST',
    `/v1/tasks/${task.id}/transitions`,
    {
      to: 'in_review',
      expected_version: task.version,
      note: 'This version is old.',
      evidence: address,
    },
    { authorization: `Bearer ${implementerToken}`, 'idempotency-key': 'stale-version' }
  );

  expect(stale.status).toBe(409);
  expect(errorCode(stale.body)).toBe('conflict');

  ctx.simulated.queueError('start', 'unavailable');

  const pending = await json(
    ctx.server,
    'POST',
    '/v1/sessions',
    {
      role: 'reviewer',
      task_id: task.id,
      instructions: 'The platform does not answer.',
    },
    { authorization: `Bearer ${implementerToken}`, 'idempotency-key': 'pending-start' }
  );

  expect(pending.status).toBe(202);
  expect(errorCode(pending.body)).toBe('start_pending');

  await ctx.db.query('UPDATE groups SET caps = $1::jsonb WHERE id = $2', [
    JSON.stringify({
      live_sessions: 4,
      live_per_role: { planner: 1, challenger: 2, implementer: 4 },
      live_per_task_role: { reviewer: 1, verifier: 1 },
      spawn_rate: 6,
      respawns_per_task_role: 3,
      total_sessions: 50,
    }),
    (created.body.group as { id: string }).id,
  ]);

  const other = await json(
    ctx.server,
    'POST',
    '/v1/tasks',
    { title: 'Another task', description: 'This task competes for the last place.' },
    { authorization: `Bearer ${token}`, 'idempotency-key': 'other-task' }
  );
  const capped = await json(
    ctx.server,
    'POST',
    '/v1/sessions',
    {
      role: 'implementer',
      task_id: (other.body.task as { id: string }).id,
      instructions: 'There is no place left.',
    },
    { authorization: `Bearer ${token}`, 'idempotency-key': 'capped' }
  );

  expect(capped.status).toBe(409);
  expect(errorCode(capped.body)).toBe('cap_reached');

  ctx.server.stop();
});

test('creating a task again with the same key does not write a second task', async () => {
  const ctx = await boot();
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'task-idem-group' }
  );
  const planner = created.body.session as { id: string };
  const root = created.body.root as { id: string; version: number };
  const token = ctx.simulated.secretFor(planner.id);

  if (token === null) throw new Error('the planner token should be injected');

  await move(ctx, token, root.id, 'analyzing', 'The plan is underway.', root.version);

  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'same-task' };
  const body = {
    title: 'Hide the tax rules',
    description: 'Move tax calculation behind an interface.',
  };
  const first = await json(ctx.server, 'POST', '/v1/tasks', body, headers);
  const second = await json(ctx.server, 'POST', '/v1/tasks', body, headers);
  const listed = await json(ctx.server, 'GET', '/v1/tasks', undefined, {
    authorization: `Bearer ${token}`,
  });
  const children = (listed.body.tasks as { parent_id: string | null }[]).filter(
    task => task.parent_id !== null
  );

  expect((first.body.task as { id: string }).id).toBe((second.body.task as { id: string }).id);
  expect(children).toHaveLength(1);

  ctx.server.stop();
});

async function enrollFromPrompt(
  ctx: Awaited<ReturnType<typeof boot>>,
  sessionId: string
): Promise<string> {
  const prompt = ctx.simulated.prompts().find(text => text.includes(sessionId)) ?? '';
  const code = /Enrollment code: (enr_[A-Za-z0-9_-]+)/.exec(prompt)?.[1];

  if (code === undefined) throw new Error(`no enrollment code for ${sessionId}`);

  const response = await json(
    ctx.server,
    'POST',
    '/v1/session/enroll',
    {
      session_id: sessionId,
      code,
    },
    { 'idempotency-key': `enroll-${sessionId}` }
  );

  expect(response.status).toBe(200);

  return String(response.body.token);
}

async function startMember(
  ctx: Awaited<ReturnType<typeof boot>>,
  token: string,
  role: string,
  taskId: string,
  instructions: string
): Promise<{ id: string }> {
  const response = await json(
    ctx.server,
    'POST',
    '/v1/sessions',
    { role, task_id: taskId, instructions },
    { authorization: `Bearer ${token}`, 'idempotency-key': `${role}-${taskId}` }
  );

  expect(response.status).toBe(201);

  return response.body.session as { id: string };
}

async function move(
  ctx: Awaited<ReturnType<typeof boot>>,
  token: string,
  taskId: string,
  to: string,
  note: string,
  version?: number,
  evidence: { label: string; kind: string; value: string }[] = []
): Promise<void> {
  const current = version ?? (await taskOf(ctx, token, taskId)).version;
  const response = await json(
    ctx.server,
    'POST',
    `/v1/tasks/${taskId}/transitions`,
    { to, expected_version: current, note, evidence },
    { authorization: `Bearer ${token}`, 'idempotency-key': `${taskId}-${to}-${current}` }
  );

  expect(response.status).toBe(200);
}

test('a retry of the end route finishes the platform stop', async () => {
  const ctx = await boot();
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'end-retry-group' }
  );
  const planner = created.body.session as { id: string };
  const token = ctx.simulated.secretFor(planner.id);

  if (token === null) throw new Error('the planner token should be injected');

  ctx.simulated.queueError('end', 'unavailable');

  const first = await json(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    { authorization: `Bearer ${token}` }
  );

  expect(first.status).toBe(503);

  const second = await json(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    { authorization: `Bearer ${token}` }
  );
  const ended = second.body.session as { life?: string };
  const group = created.body.group as { id: string };
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, requireGroupId(group.id));

  expect(second.status).toBe(200);
  expect(ended.life).toBe('ended');
  expect(occupancy.live_sessions).toBe(0);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(2);

  ctx.server.stop();
});

test('an ending member cannot write or start until the stop finishes', async () => {
  const ctx = await boot();
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'ending-writes-group' }
  );
  const planner = created.body.session as { id: string };
  const root = created.body.root as { id: string; version: number };
  const token = ctx.simulated.secretFor(planner.id);

  if (token === null) throw new Error('the planner token should be injected');

  ctx.simulated.queueError('end', 'unavailable');

  const stopped = await json(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    { authorization: `Bearer ${token}` }
  );
  const moved = await json(
    ctx.server,
    'POST',
    `/v1/tasks/${root.id}/transitions`,
    {
      to: 'analyzing',
      expected_version: root.version,
      note: 'The plan is underway.',
      evidence: [],
    },
    { authorization: `Bearer ${token}`, 'idempotency-key': 'ending-move' }
  );
  const started = await json(
    ctx.server,
    'POST',
    '/v1/sessions',
    {
      role: 'challenger',
      task_id: root.id,
      instructions: 'Read the plan.',
    },
    { authorization: `Bearer ${token}`, 'idempotency-key': 'ending-start' }
  );
  const finished = await json(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    { authorization: `Bearer ${token}` }
  );
  const task = await ctx.deps.store.tasks(
    defaultWorkspaceId,
    requireGroupId((created.body.group as { id: string }).id)
  );
  const rootAfter = task.find(item => item.id === root.id);
  const sessions = await ctx.deps.store.sessions(
    defaultWorkspaceId,
    requireGroupId((created.body.group as { id: string }).id)
  );

  expect(stopped.status).toBe(503);
  expect(moved.status).toBe(403);
  expect(errorCode(moved.body)).toBe('session_not_active');
  expect(started.status).toBe(403);
  expect(errorCode(started.body)).toBe('session_not_active');
  expect(finished.status).toBe(200);
  expect((finished.body.session as { life?: string }).life).toBe('ended');
  expect(rootAfter?.state).toBe('planned');
  expect(sessions.map(session => session.role)).toEqual(['planner']);

  ctx.server.stop();
});

test('a retry of self-end finishes the platform stop', async () => {
  const ctx = await boot();
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'self-end-group' }
  );
  const planner = created.body.session as { id: string };
  const token = ctx.simulated.secretFor(planner.id);

  if (token === null) throw new Error('the planner token should be injected');

  ctx.simulated.queueError('end', 'unavailable');

  const first = await json(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'Stop after the platform refuses once.' },
    { authorization: `Bearer ${token}` }
  );
  const second = await json(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'Stop after the platform refuses once.' },
    { authorization: `Bearer ${token}` }
  );
  const groupId = requireGroupId((created.body.group as { id: string }).id);
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, groupId);

  expect(first.status).toBe(503);
  expect(second.status).toBe(200);
  expect((second.body.session as { life?: string }).life).toBe('ended');
  expect(occupancy.live_sessions).toBe(0);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(2);

  ctx.server.stop();
});

test('a lost self-end can be confirmed without restoring access', async () => {
  const ctx = await boot();
  const key = await creatorKey(ctx);
  const created = await json(
    ctx.server,
    'POST',
    '/v1/groups',
    {
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    },
    { authorization: `Bearer ${key}`, 'idempotency-key': 'lost-end-group' }
  );
  const planner = created.body.session as { id: string };
  const token = ctx.simulated.secretFor(planner.id);

  if (token === null) throw new Error('the planner token should be injected');

  const first = await json(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'The success response was lost.' },
    { authorization: `Bearer ${token}` }
  );
  const again = await json(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'The success response was lost.' },
    { authorization: `Bearer ${token}` }
  );
  const tasks = await json(ctx.server, 'GET', '/v1/tasks', undefined, {
    authorization: `Bearer ${token}`,
  });

  expect(first.status).toBe(200);
  expect((first.body.session as { life?: string }).life).toBe('ended');
  expect(again.status).toBe(200);
  expect((again.body.session as { life?: string }).life).toBe('ended');
  expect(tasks.status).toBe(401);
  expect(errorCode(tasks.body)).toBe('unauthenticated');

  ctx.server.stop();
});

async function taskOf(
  ctx: Awaited<ReturnType<typeof boot>>,
  token: string,
  taskId: string
): Promise<{ id: string; version: number; state: string }> {
  const response = await json(ctx.server, 'GET', `/v1/tasks/${taskId}`, undefined, {
    authorization: `Bearer ${token}`,
  });

  return response.body.task as { id: string; version: number; state: string };
}

async function rootTask(
  ctx: Awaited<ReturnType<typeof boot>>,
  token: string
): Promise<{ id: string; version: number; state: string }> {
  const response = await json(ctx.server, 'GET', '/v1/tasks', undefined, {
    authorization: `Bearer ${token}`,
  });
  const tasks = response.body.tasks as {
    id: string;
    version: number;
    state: string;
    parent_id: string | null;
  }[];
  const root = tasks.find(task => task.parent_id === null);

  if (root === undefined) throw new Error('the group has no root task');

  return root;
}
