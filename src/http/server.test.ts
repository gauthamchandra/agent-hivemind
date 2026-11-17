import { expect, test } from 'bun:test';
import { defaultWorkspaceId, requireGroupId, requireSessionId } from '@/domain/ids.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootHttpService, type HttpService } from '@/testing/boot.ts';
import { passingCheckEvidence, pullRequestEvidence } from '@/testing/fixtures.ts';
import {
  bearer,
  bootstrapCreatorKey,
  createCheckoutGroup,
  expectStatus,
  sendJson,
} from '@/testing/http.ts';
import { enrollmentCodeIn, promptMentioning } from '@/testing/platforms.ts';

function errorCode(body: Record<string, unknown>): string {
  const error = body.error as { code?: string } | undefined;

  return error?.code ?? '';
}

async function creatorKey(ctx: HttpService): Promise<string> {
  return bootstrapCreatorKey(ctx.server, ctx.bootstrap);
}

test('a bootstrap key cannot mint another bootstrap key', async () => {
  const ctx = await bootHttpService();

  await sendJson(
    ctx.server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    bearer(ctx.bootstrap)
  );
  const refused = await sendJson(
    ctx.server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'again', role: 'bootstrap' },
    bearer(ctx.bootstrap)
  );
  const error = refused.body.error as { message?: string };

  expectStatus(refused, 422);
  expect(errorCode(refused.body)).toBe('validation_failed');
  expect(error.message).toBe('The bootstrap key cannot create another bootstrap key.');
});

test('a numeric key expiry is refused', async () => {
  const ctx = await bootHttpService();
  const created = await sendJson(
    ctx.server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    bearer(ctx.bootstrap)
  );

  expectStatus(created, 201);

  const refused = await sendJson(
    ctx.server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'creator', role: 'creator', expires_at: 1 },
    bearer(ctx.bootstrap)
  );
  const absent = await sendJson(
    ctx.server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'later', role: 'creator', expires_at: null },
    bearer(ctx.bootstrap)
  );

  expectStatus(refused, 422);
  expect(errorCode(refused.body)).toBe('validation_failed');
  expectStatus(absent, 201);
  expect(typeof absent.body.secret).toBe('string');
});

test('a lowercase bearer scheme is accepted', async () => {
  const ctx = await bootHttpService();
  const created = await sendJson(
    ctx.server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    { authorization: `bearer ${ctx.bootstrap}` }
  );

  expectStatus(created, 201);
});

test('a body over 256 KiB is refused before it is handled', async () => {
  const ctx = await bootHttpService();
  const response = await fetch(`${ctx.server.url}/healthz`, {
    method: 'POST',
    body: 'x'.repeat(256 * 1024 + 1),
  });

  expect(response.status).toBe(413);
  expect(await response.text()).toBe('');
});

async function enrollFromPrompt(ctx: HttpService, sessionId: string): Promise<string> {
  const code = enrollmentCodeIn(promptMentioning(ctx.simulated, sessionId));

  const response = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/enroll',
    {
      session_id: sessionId,
      code,
    },
    { 'idempotency-key': `enroll-${sessionId}` }
  );

  expectStatus(response, 200);

  return String(response.body.token);
}

async function startMember(
  ctx: HttpService,
  token: string,
  role: string,
  taskId: string,
  instructions: string
): Promise<{ id: string }> {
  const response = await sendJson(
    ctx.server,
    'POST',
    '/v1/sessions',
    { role, task_id: taskId, instructions },
    { ...bearer(token), 'idempotency-key': `${role}-${taskId}` }
  );

  expectStatus(response, 201);

  return response.body.session as { id: string };
}

async function move(
  ctx: HttpService,
  token: string,
  taskId: string,
  to: string,
  note: string,
  version?: number,
  evidence: { label: string; kind: string; value: string }[] = []
): Promise<void> {
  const current = version ?? (await taskOf(ctx, token, taskId)).version;
  const response = await sendJson(
    ctx.server,
    'POST',
    `/v1/tasks/${taskId}/transitions`,
    { to, expected_version: current, note, evidence },
    { ...bearer(token), 'idempotency-key': `${taskId}-${to}-${current}` }
  );

  expectStatus(response, 200);
}

async function taskOf(
  ctx: HttpService,
  token: string,
  taskId: string
): Promise<{ id: string; version: number; state: string }> {
  const response = await sendJson(ctx.server, 'GET', `/v1/tasks/${taskId}`, undefined, {
    ...bearer(token),
  });

  return response.body.task as { id: string; version: number; state: string };
}

async function rootTask(
  ctx: HttpService,
  token: string
): Promise<{ id: string; version: number; state: string }> {
  const response = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });
  const tasks = response.body.tasks as {
    id: string;
    version: number;
    state: string;
    parent_id: string | null;
  }[];
  const root = requirePresent(
    tasks.find(task => task.parent_id === null),
    'the group has no root task'
  );

  return root;
}

async function finishScriptedGroup(
  ctx: HttpService,
  plannerToken: string,
  group: { id: string },
  task: { id: string },
  implementerToken: string
): Promise<void> {
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
    pullRequestEvidence
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
    pullRequestEvidence
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
    passingCheckEvidence
  );

  const doneFrom = await taskOf(ctx, reviewerToken, task.id);

  await move(
    ctx,
    reviewerToken,
    task.id,
    'done',
    'The pull request merged.',
    doneFrom.version,
    pullRequestEvidence
  );

  const rootAfter = await rootTask(ctx, plannerToken);
  const members = await sendJson(ctx.server, 'GET', '/v1/sessions', undefined, {
    ...bearer(plannerToken),
  });
  const roles = ((members.body.sessions as { role: string }[]) ?? []).map(session => session.role);

  expect(rootAfter.state).toBe('done');
  expect(roles.sort()).toEqual(
    ['challenger', 'implementer', 'planner', 'reviewer', 'verifier'].sort()
  );
  expect(group.id.startsWith('grp_')).toBe(true);
}

async function resumeAndRecord(
  ctx: HttpService,
  token: string,
  task: { id: string; version: number }
): Promise<void> {
  await sendJson(
    ctx.server,
    'POST',
    '/v1/session/resume',
    {},
    { ...bearer(token), 'idempotency-key': 'errors-resume' }
  );

  const implementer = await startMember(ctx, token, 'implementer', task.id, 'Write the change.');
  const implementerToken = requirePresent(
    ctx.simulated.secretFor(implementer.id),
    'the implementer token should be injected'
  );

  const badTransition = await sendJson(
    ctx.server,
    'POST',
    `/v1/tasks/${task.id}/transitions`,
    {
      to: 'approved',
      expected_version: task.version,
      note: 'This skip is not in the table.',
      evidence: [],
    },
    { ...bearer(implementerToken), 'idempotency-key': 'bad-transition' }
  );

  expectStatus(badTransition, 409);
  expect(errorCode(badTransition.body)).toBe('invalid_transition');

  const current = await taskOf(ctx, implementerToken, task.id);

  await move(ctx, implementerToken, task.id, 'implementing', 'Work has started.', current.version);

  const reviewing = await taskOf(ctx, implementerToken, task.id);
  const missingEvidence = await sendJson(
    ctx.server,
    'POST',
    `/v1/tasks/${task.id}/transitions`,
    {
      to: 'in_review',
      expected_version: reviewing.version,
      note: 'The pull request exists.',
      evidence: [],
    },
    { ...bearer(implementerToken), 'idempotency-key': 'missing-evidence' }
  );

  expectStatus(missingEvidence, 422);
  expect(errorCode(missingEvidence.body)).toBe('evidence_required');

  const stale = await sendJson(
    ctx.server,
    'POST',
    `/v1/tasks/${task.id}/transitions`,
    {
      to: 'in_review',
      expected_version: task.version,
      note: 'This version is old.',
      evidence: pullRequestEvidence,
    },
    { ...bearer(implementerToken), 'idempotency-key': 'stale-version' }
  );

  expectStatus(stale, 409);
  expect(errorCode(stale.body)).toBe('conflict');

  ctx.simulated.queueError('start', 'unavailable');

  const pending = await sendJson(
    ctx.server,
    'POST',
    '/v1/sessions',
    {
      role: 'reviewer',
      task_id: task.id,
      instructions: 'The platform does not answer.',
    },
    { ...bearer(implementerToken), 'idempotency-key': 'pending-start' }
  );

  expectStatus(pending, 202);
  expect(errorCode(pending.body)).toBe('start_pending');
}

async function showCapReached(
  ctx: HttpService,
  token: string,
  created: { body: Record<string, unknown> }
): Promise<void> {
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

  const other = await sendJson(
    ctx.server,
    'POST',
    '/v1/tasks',
    { title: 'Another task', description: 'This task competes for the last place.' },
    { ...bearer(token), 'idempotency-key': 'other-task' }
  );
  const capped = await sendJson(
    ctx.server,
    'POST',
    '/v1/sessions',
    {
      role: 'implementer',
      task_id: (other.body.task as { id: string }).id,
      instructions: 'There is no place left.',
    },
    { ...bearer(token), 'idempotency-key': 'capped' }
  );

  expectStatus(capped, 409);
  expect(errorCode(capped.body)).toBe('cap_reached');
}

test('a member can read the task history', async () => {
  const ctx = await bootHttpService({ secretInjection: false });
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'history-group', {
    instructions: 'Plan the work and start the team.',
    verification_mode: 'before_merge',
  });
  const root = created.body.root as { id: string };
  const planner = created.body.session as { id: string };
  const token = await enrollFromPrompt(ctx, planner.id);
  const history = await sendJson(ctx.server, 'GET', `/v1/tasks/${root.id}/events`, undefined, {
    ...bearer(token),
  });
  const events = history.body.events as { task_id?: string; kind?: string }[];

  expectStatus(created, 201);
  expectStatus(history, 200);
  expect(events.some(event => event.task_id === root.id && event.kind === 'created')).toBe(true);
});

test('a scripted group reaches done through HTTP without a platform call on transition', async () => {
  const ctx = await bootHttpService({ secretInjection: false });
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'group-1', {
    instructions: 'Plan the work and start the team.',
    verification_mode: 'before_merge',
  });

  expectStatus(created, 201);

  const group = created.body.group as { id: string };
  const rootCreated = created.body.root as { id: string };
  const planner = created.body.session as { id: string };
  const plannerToken = await enrollFromPrompt(ctx, planner.id);

  await move(ctx, plannerToken, rootCreated.id, 'analyzing', 'The plan is underway.');

  const child = await sendJson(
    ctx.server,
    'POST',
    '/v1/tasks',
    {
      title: 'Hide the tax rules',
      description: 'Move tax calculation behind an interface.',
    },
    { ...bearer(plannerToken), 'idempotency-key': 'task-1' }
  );

  expectStatus(child, 201);

  const task = child.body.task as { id: string; version: number };
  const challenger = await startMember(
    ctx,
    plannerToken,
    'challenger',
    rootCreated.id,
    'Challenge the plan.'
  );
  const challengerToken = await enrollFromPrompt(ctx, challenger.id);

  await sendJson(ctx.server, 'GET', '/v1/session', undefined, {
    ...bearer(challengerToken),
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

  await finishScriptedGroup(ctx, plannerToken, group, task, implementerToken);
});
test('the session routes return the named error codes', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'errors-group');
  const root = created.body.root as { id: string; version: number };
  const planner = created.body.session as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  const missing = await sendJson(ctx.server, 'GET', '/v1/session');

  expectStatus(missing, 401);
  expect(errorCode(missing.body)).toBe('unauthenticated');

  await move(ctx, token, root.id, 'analyzing', 'The plan is underway.', root.version);

  const child = await sendJson(
    ctx.server,
    'POST',
    '/v1/tasks',
    { title: 'Hide the tax rules', description: 'Move tax calculation behind an interface.' },
    { ...bearer(token), 'idempotency-key': 'errors-task' }
  );
  const task = child.body.task as { id: string; version: number };
  const challenger = await startMember(ctx, token, 'challenger', root.id, 'Read the plan.');
  const challengerToken = requirePresent(
    ctx.simulated.secretFor(challenger.id),
    'the challenger token should be injected'
  );

  const denied = await sendJson(
    ctx.server,
    'POST',
    '/v1/sessions',
    { role: 'implementer', task_id: task.id, instructions: 'A challenger cannot start this.' },
    { ...bearer(challengerToken), 'idempotency-key': 'denied' }
  );

  expectStatus(denied, 403);
  expect(errorCode(denied.body)).toBe('policy_denied');

  await sendJson(
    ctx.server,
    'POST',
    '/v1/session/release',
    {},
    { ...bearer(token), 'idempotency-key': 'errors-release' }
  );

  const inactive = await sendJson(
    ctx.server,
    'POST',
    '/v1/sessions',
    { role: 'implementer', task_id: task.id, instructions: 'A released planner cannot start.' },
    { ...bearer(token), 'idempotency-key': 'inactive' }
  );

  expectStatus(inactive, 403);
  expect(errorCode(inactive.body)).toBe('session_not_active');

  await resumeAndRecord(ctx, token, task);
  await showCapReached(ctx, token, created);
});
test('creating a task again with the same key does not write a second task', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'task-idem-group');
  const planner = created.body.session as { id: string };
  const root = created.body.root as { id: string; version: number };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  await move(ctx, token, root.id, 'analyzing', 'The plan is underway.', root.version);

  const headers = { ...bearer(token), 'idempotency-key': 'same-task' };
  const body = {
    title: 'Hide the tax rules',
    description: 'Move tax calculation behind an interface.',
  };
  const first = await sendJson(ctx.server, 'POST', '/v1/tasks', body, headers);
  const second = await sendJson(ctx.server, 'POST', '/v1/tasks', body, headers);
  const listed = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });
  const children = (listed.body.tasks as { parent_id: string | null }[]).filter(
    task => task.parent_id !== null
  );

  expect((first.body.task as { id: string }).id).toBe((second.body.task as { id: string }).id);
  expect(children).toHaveLength(1);
});

test('a retry of the end route finishes the platform stop', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'end-retry-group');
  const planner = created.body.session as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  ctx.simulated.queueError('end', 'unavailable');

  const first = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    bearer(token)
  );

  expectStatus(first, 503);

  const second = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    bearer(token)
  );
  const ended = second.body.session as { life?: string };
  const group = created.body.group as { id: string };
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, requireGroupId(group.id));

  expectStatus(second, 200);
  expect(ended.life).toBe('ended');
  expect(occupancy.live_sessions).toBe(0);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(2);
});

test('a lost self-end can be confirmed without restoring access', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'lost-end-group');
  const planner = created.body.session as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  const first = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'The success response was lost.' },
    bearer(token)
  );
  const again = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'The success response was lost.' },
    bearer(token)
  );
  const tasks = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });

  expectStatus(first, 200);
  expect((first.body.session as { life?: string }).life).toBe('ended');
  expectStatus(again, 200);
  expect((again.body.session as { life?: string }).life).toBe('ended');
  expectStatus(tasks, 401);
  expect(errorCode(tasks.body)).toBe('unauthenticated');
});

test('an implementer receipt confirms an end on both routes', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'receipt-group');
  const root = created.body.root as { id: string; version: number };
  const planner = created.body.session as { id: string };
  const plannerToken = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  await move(ctx, plannerToken, root.id, 'analyzing', 'The plan is underway.', root.version);

  const child = await sendJson(
    ctx.server,
    'POST',
    '/v1/tasks',
    { title: 'Hide the tax rules', description: 'Move tax calculation behind an interface.' },
    { ...bearer(plannerToken), 'idempotency-key': 'receipt-task' }
  );
  const task = child.body.task as { id: string };
  const analyzing = await taskOf(ctx, plannerToken, root.id);

  await move(ctx, plannerToken, root.id, 'implementing', 'A child task exists.', analyzing.version);

  const implementer = await startMember(ctx, plannerToken, 'implementer', task.id, 'Write it.');
  const implementerToken = requirePresent(
    ctx.simulated.secretFor(implementer.id),
    'the implementer token should be injected'
  );

  const ended = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${implementer.id}/end`,
    { reason: 'The planner ended this session.' },
    { ...bearer(plannerToken), 'idempotency-key': 'planner-ends-implementer' }
  );
  const self = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'The receipt confirms the saved end.' },
    { ...bearer(implementerToken), 'idempotency-key': 'receipt-self' }
  );
  const member = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${implementer.id}/end`,
    { reason: 'The receipt confirms the saved end.' },
    { ...bearer(implementerToken), 'idempotency-key': 'receipt-member' }
  );
  const tasks = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(implementerToken),
  });

  expectStatus(ended, 200);
  expectStatus(self, 200);
  expect((self.body.session as { life: string }).life).toBe('ended');
  expectStatus(member, 200);
  expect((member.body.session as { life: string }).life).toBe('ended');
  expectStatus(tasks, 401);
});

test('a self-end retry finishes a pending usage read', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'pending-usage-self');
  const planner = created.body.session as { id: string };
  const group = created.body.group as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  ctx.simulated.controls.setReportedUsage(4);
  ctx.simulated.queueError('readUsage', 'unavailable');

  const first = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'The usage read failed.' },
    bearer(token)
  );
  const pending = await ctx.deps.store.session(defaultWorkspaceId, requireSessionId(planner.id));
  const again = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'Read the usage that was missed.' },
    bearer(token)
  );
  const tasks = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });
  const stored = await ctx.deps.store.group(defaultWorkspaceId, requireGroupId(group.id));

  expectStatus(first, 200);
  expect(pending?.life).toBe('ended');
  expect(pending?.final_usage_pending).toBe(true);
  expectStatus(again, 200);
  expect((again.body.session as { final_usage_pending?: boolean }).final_usage_pending).toBe(false);
  expect(stored?.spend).toBe('4');
  expectStatus(tasks, 401);
  expect(errorCode(tasks.body)).toBe('unauthenticated');
});

test('a member-end retry finishes a pending usage read', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'pending-usage-member');
  const planner = created.body.session as { id: string };
  const group = created.body.group as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  ctx.simulated.controls.setReportedUsage(4);
  ctx.simulated.queueError('readUsage', 'unavailable');

  const first = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'The usage read failed.' },
    bearer(token)
  );
  const pending = await ctx.deps.store.session(defaultWorkspaceId, requireSessionId(planner.id));
  const again = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Read the usage that was missed.' },
    bearer(token)
  );
  const tasks = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });
  const stored = await ctx.deps.store.group(defaultWorkspaceId, requireGroupId(group.id));

  expectStatus(first, 200);
  expect(pending?.life).toBe('ended');
  expect(pending?.final_usage_pending).toBe(true);
  expectStatus(again, 200);
  expect((again.body.session as { final_usage_pending?: boolean }).final_usage_pending).toBe(false);
  expect(stored?.spend).toBe('4');
  expectStatus(tasks, 401);
  expect(errorCode(tasks.body)).toBe('unauthenticated');
});

test('a self-end retry stops a platform session found after the row ended', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'late-ref-self');
  const planner = created.body.session as { id: string };
  const group = created.body.group as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  await forgetPlatformReference(ctx, planner.id);
  ctx.simulated.controls.setReportedUsage(4);

  const again = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'Stop the session the platform accepted later.' },
    bearer(token)
  );
  const tasks = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });
  const stored = await ctx.deps.store.group(defaultWorkspaceId, requireGroupId(group.id));

  expectStatus(again, 200);

  const ref = requirePlatformRef(again.body.session);

  expect((again.body.session as { final_usage_pending?: boolean }).final_usage_pending).toBe(false);
  expect(stored?.spend).toBe('4');
  expect(await ctx.simulated.adapter.send(ctx.simulated.connection(), ref, 'ping')).toBe('gone');
  expectStatus(tasks, 401);
  expect(errorCode(tasks.body)).toBe('unauthenticated');
});

test('a member-end retry stops a platform session found after the row ended', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'late-ref-member');
  const planner = created.body.session as { id: string };
  const group = created.body.group as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  await forgetPlatformReference(ctx, planner.id);
  ctx.simulated.controls.setReportedUsage(4);

  const again = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop the session the platform accepted later.' },
    bearer(token)
  );
  const tasks = await sendJson(ctx.server, 'GET', '/v1/tasks', undefined, {
    ...bearer(token),
  });
  const stored = await ctx.deps.store.group(defaultWorkspaceId, requireGroupId(group.id));

  expectStatus(again, 200);

  const ref = requirePlatformRef(again.body.session);

  expect((again.body.session as { final_usage_pending?: boolean }).final_usage_pending).toBe(false);
  expect(stored?.spend).toBe('4');
  expect(await ctx.simulated.adapter.send(ctx.simulated.connection(), ref, 'ping')).toBe('gone');
  expectStatus(tasks, 401);
  expect(errorCode(tasks.body)).toBe('unauthenticated');
});

test('an ending member cannot write or start until the stop finishes', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'ending-writes-group');
  const planner = created.body.session as { id: string };
  const root = created.body.root as { id: string; version: number };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  ctx.simulated.queueError('end', 'unavailable');

  const stopped = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    bearer(token)
  );
  const moved = await sendJson(
    ctx.server,
    'POST',
    `/v1/tasks/${root.id}/transitions`,
    {
      to: 'analyzing',
      expected_version: root.version,
      note: 'The plan is underway.',
      evidence: [],
    },
    { ...bearer(token), 'idempotency-key': 'ending-move' }
  );
  const started = await sendJson(
    ctx.server,
    'POST',
    '/v1/sessions',
    {
      role: 'challenger',
      task_id: root.id,
      instructions: 'Read the plan.',
    },
    { ...bearer(token), 'idempotency-key': 'ending-start' }
  );
  const finished = await sendJson(
    ctx.server,
    'POST',
    `/v1/sessions/${planner.id}/end`,
    { reason: 'Stop after the platform refuses once.' },
    bearer(token)
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

  expectStatus(stopped, 503);
  expectStatus(moved, 403);
  expect(errorCode(moved.body)).toBe('session_not_active');
  expectStatus(started, 403);
  expect(errorCode(started.body)).toBe('session_not_active');
  expectStatus(finished, 200);
  expect((finished.body.session as { life?: string }).life).toBe('ended');
  expect(rootAfter?.state).toBe('planned');
  expect(sessions.map(session => session.role)).toEqual(['planner']);
});
test('a retry of self-end finishes the platform stop', async () => {
  const ctx = await bootHttpService();
  const key = await creatorKey(ctx);
  const created = await createCheckoutGroup(ctx.server, key, 'self-end-group');
  const planner = created.body.session as { id: string };
  const token = requirePresent(
    ctx.simulated.secretFor(planner.id),
    'the planner token should be injected'
  );

  ctx.simulated.queueError('end', 'unavailable');

  const first = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'Stop after the platform refuses once.' },
    bearer(token)
  );
  const second = await sendJson(
    ctx.server,
    'POST',
    '/v1/session/end',
    { reason: 'Stop after the platform refuses once.' },
    bearer(token)
  );
  const groupId = requireGroupId((created.body.group as { id: string }).id);
  const occupancy = await ctx.deps.store.occupancy(defaultWorkspaceId, groupId);

  expectStatus(first, 503);
  expectStatus(second, 200);
  expect((second.body.session as { life?: string }).life).toBe('ended');
  expect(occupancy.live_sessions).toBe(0);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(2);
});

function requirePlatformRef(session: unknown): string {
  if (typeof session !== 'object' || session === null || !('platform_session_ref' in session)) {
    throw new Error('the session should expose a platform reference');
  }

  const ref = session.platform_session_ref;

  if (typeof ref !== 'string' || ref === '') {
    throw new Error('the session should expose a platform reference');
  }

  return ref;
}

async function forgetPlatformReference(ctx: HttpService, sessionId: string): Promise<void> {
  const id = requireSessionId(sessionId);
  const stored = await ctx.deps.store.session(defaultWorkspaceId, id);

  if (stored?.token_hash == null) throw new Error('the session should still have a token');

  const hash = stored.token_hash;

  await ctx.db.query(
    `UPDATE sessions
        SET life = 'ended',
            platform_session_ref = NULL,
            final_usage_pending = false,
            token_hash = NULL,
            ended_at = created_at
      WHERE id = $1`,
    [sessionId]
  );
  await ctx.deps.store.transact(tx =>
    tx.insertIdempotency({
      workspaceId: defaultWorkspaceId,
      callerKind: 'end_receipt',
      callerId: hash,
      route: 'session.end',
      key: 'token',
      bodyHash: hash,
      recordId: sessionId,
      completed: true,
      at: stored.created_at,
    })
  );
}
