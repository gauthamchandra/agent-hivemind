import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { ReportActor, ServiceDeps } from '@/core/deps.ts';
import { correctBudget, createGroup, raiseBudget } from '@/core/group-records.ts';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { reportTransition } from '@/core/report-records.ts';
import { createChildTask } from '@/core/task-records.ts';
import { fingerprintText, renderContextNotes } from '@/domain/context.ts';
import {
  defaultWorkspaceId,
  type GroupId,
  type PersonId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
} from '@/domain/ids.ts';
import {
  type EvidenceEntry,
  type Group,
  selfHostedGroupCaps,
  type TaskState,
  type VerificationMode,
} from '@/domain/model.ts';
import type { RandomSource } from '@/ports/random.ts';
import { expectHivemindError, requirePresent } from '@/testing/assertions.ts';
import { createTestDeps, fixedRandom, type TestDeps } from '@/testing/deps.ts';
import { note, passingCheckEvidence, pullRequestEvidence } from '@/testing/fixtures.ts';
import { openEmptyDatabase, openMigratedDatabase } from '@/testing/pglite.ts';

const dayMs = 24 * 60 * 60 * 1000;

/** The first 32-byte draw is the bootstrap secret. Later secrets must differ or the hash collides. */
function bootstrapRandom(): RandomSource {
  let secrets = 0;

  return {
    bytes(length) {
      if (length === 32) {
        secrets += 1;

        return new Uint8Array(length).fill(secrets === 1 ? 7 : 8);
      }

      return new Uint8Array(length).fill(7);
    },
  };
}

async function openMigratedDatabaseWithDeps(): Promise<{
  db: PGlite;
  deps: TestDeps;
}> {
  const db = await openMigratedDatabase();

  return { db, deps: createTestDeps(db, { random: fixedRandom(7) }) };
}

async function expectInvariants(db: PGlite, workspaceId: string): Promise<void> {
  const tables = [
    'people',
    'operator_keys',
    'groups',
    'context_notes',
    'tasks',
    'task_events',
  ] as const;

  for (const table of tables) {
    const result = await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM ${table}`);

    for (const row of result.rows) {
      expect(row.workspace_id).toBe(workspaceId);
    }
  }

  const roots = await db.query<{ group_id: string; roots: number }>(
    `SELECT group_id, count(*)::int AS roots FROM tasks WHERE parent_id IS NULL GROUP BY group_id`
  );

  for (const row of roots.rows) {
    expect(row.roots).toBe(1);
  }

  const below = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM groups WHERE budget < spend`
  );

  expect(below.rows[0]?.count).toBe(0);
}

type Walk = {
  db: PGlite;
  deps: ServiceDeps;
  workspaceId: WorkspaceId;
  admin: { id: PersonId };
  sessions: {
    planner: SessionId;
    implementer: SessionId;
    reviewer: SessionId;
    verifier: SessionId;
  };
  actor: (role: 'planner' | 'implementer' | 'reviewer' | 'verifier', live?: boolean) => ReportActor;
};

async function prepareWalk(): Promise<Walk> {
  const { db, deps } = await openMigratedDatabaseWithDeps();
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });
  const workspaceId = opened.workspace.id;
  const sessions = {
    planner: deps.ids.session(),
    implementer: deps.ids.session(),
    reviewer: deps.ids.session(),
    verifier: deps.ids.session(),
  };
  const actor = (role: keyof typeof sessions, live = true): ReportActor => ({
    kind: 'session',
    role,
    sessionId: sessions[role],
    live,
  });

  return { db, deps, workspaceId, admin, sessions, actor };
}

async function startGroup(ctx: Walk, mode: VerificationMode | null, goal: string) {
  const notes = mode === null ? [{ name: 'Standards', body: 'Write the test first.' }] : [];
  const created = await createGroup(ctx.deps, {
    workspaceId: ctx.workspaceId,
    personId: ctx.admin.id,
    name: 'Checkout refactor',
    goal,
    budget: '10',
    connectionId: ctx.deps.ids.connection(),
    verificationMode: mode,
    notes,
  });

  expect(created.root.parent_id).toBeNull();
  expect(created.root.state).toBe('planned');
  expect(created.root.version).toBe(1);
  expect(created.group.caps).toEqual(selfHostedGroupCaps);
  expect(created.group.spend).toBe('0');
  expect(created.group.owner_person_id).toBe(ctx.admin.id);
  expect(created.group.context_fingerprint).toBe(fingerprintText(renderContextNotes(notes)));
  if (notes.length === 0) {
    expect(created.group.context_fingerprint).toBe(createHash('sha256').update('').digest('hex'));
  } else {
    expect(renderContextNotes(notes)).toContain('### Standards');
  }

  const analyzed = await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: created.group.id,
    taskId: created.root.id,
    expectedVersion: created.root.version,
    actor: ctx.actor('planner'),
    to: 'analyzing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });

  return { group: analyzed.group, root: analyzed.task };
}

async function addChild(ctx: Walk, groupId: GroupId, mode: VerificationMode | null, title: string) {
  return createChildTask(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId,
    actor: { sessionId: ctx.sessions.planner, live: true },
    title,
    description: 'Do the work described by the title.',
    verificationMode: mode,
    dependsOn: [],
  });
}

async function move(
  ctx: Walk,
  groupId: GroupId,
  task: { id: TaskId; version: number },
  role: 'planner' | 'implementer' | 'reviewer' | 'verifier',
  to: TaskState,
  evidence: EvidenceEntry[],
  nextMode: VerificationMode | null = null
) {
  const result = await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId,
    taskId: task.id,
    expectedVersion: task.version,
    actor: ctx.actor(role),
    to,
    note,
    evidence,
    nextVerificationMode: nextMode,
  });

  expect(result.task.state).toBe(to);
  return result;
}

async function walkBefore(ctx: Walk) {
  const before = await startGroup(ctx, 'before_merge', 'Ship the record before merge.');
  const beforeChild = await addChild(ctx, before.group.id, null, 'Store the task');
  await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: before.group.id,
    taskId: before.root.id,
    expectedVersion: before.root.version,
    actor: ctx.actor('planner'),
    to: 'implementing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });
  const implementing = await move(
    ctx,
    before.group.id,
    beforeChild.task,
    'implementer',
    'implementing',
    []
  );
  const eventsBeforeIllegal = await ctx.deps.store.events(ctx.workspaceId, before.group.id);

  await expectHivemindError(
    reportTransition(ctx.deps, {
      workspaceId: ctx.workspaceId,
      groupId: before.group.id,
      taskId: implementing.task.id,
      expectedVersion: implementing.task.version,
      actor: ctx.actor('implementer'),
      to: 'done',
      note,
      evidence: pullRequestEvidence,
      nextVerificationMode: null,
    }),
    'invalid_transition'
  );

  const unchanged = await ctx.deps.store.tasks(ctx.workspaceId, before.group.id);
  const still = unchanged.find(task => task.id === implementing.task.id);
  expect(still?.state).toBe('implementing');
  expect(await ctx.deps.store.events(ctx.workspaceId, before.group.id)).toHaveLength(
    eventsBeforeIllegal.length
  );

  await expectHivemindError(
    reportTransition(ctx.deps, {
      workspaceId: ctx.workspaceId,
      groupId: before.group.id,
      taskId: implementing.task.id,
      expectedVersion: implementing.task.version - 1,
      actor: ctx.actor('implementer'),
      to: 'in_review',
      note,
      evidence: pullRequestEvidence,
      nextVerificationMode: null,
    }),
    'conflict'
  );

  let task = implementing.task;
  task = (await move(ctx, before.group.id, task, 'implementer', 'in_review', pullRequestEvidence))
    .task;
  task = (await move(ctx, before.group.id, task, 'reviewer', 'approved', pullRequestEvidence)).task;
  task = (await move(ctx, before.group.id, task, 'reviewer', 'verifying_before_merge', [])).task;
  task = (await move(ctx, before.group.id, task, 'verifier', 'merging', passingCheckEvidence)).task;
  task = (await move(ctx, before.group.id, task, 'reviewer', 'done', pullRequestEvidence)).task;

  const closedAgain = await expectHivemindError(
    reportTransition(ctx.deps, {
      workspaceId: ctx.workspaceId,
      groupId: before.group.id,
      taskId: task.id,
      expectedVersion: task.version,
      actor: ctx.actor('reviewer'),
      to: 'implementing',
      note,
      evidence: [],
      nextVerificationMode: null,
    }),
    'invalid_transition'
  );
  expect(closedAgain.details.current_state).toBe('done');

  const beforeRoot = await ctx.deps.store.tasks(ctx.workspaceId, before.group.id);
  const root = beforeRoot.find(item => item.parent_id === null);
  const beforeGroup = await ctx.deps.store.group(ctx.workspaceId, before.group.id);
  expect(root?.state).toBe('done');
  expect(beforeGroup?.status).toBe('closed');

  const serviceClose = (await ctx.deps.store.events(ctx.workspaceId, before.group.id)).find(
    event => event.actor_kind === 'service' && event.to_state === 'done'
  );
  expect(serviceClose?.task_id).toBe(root?.id);
  return before;
}

async function walkAfter(ctx: Walk) {
  const after = await startGroup(ctx, 'after_merge', 'Ship the record after merge.');
  let afterTask = (await addChild(ctx, after.group.id, 'after_merge', 'Store the review')).task;
  await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: after.group.id,
    taskId: after.root.id,
    expectedVersion: after.root.version,
    actor: ctx.actor('planner'),
    to: 'implementing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });
  afterTask = (await move(ctx, after.group.id, afterTask, 'implementer', 'implementing', [])).task;
  afterTask = (
    await move(ctx, after.group.id, afterTask, 'implementer', 'in_review', pullRequestEvidence)
  ).task;
  afterTask = (
    await move(ctx, after.group.id, afterTask, 'reviewer', 'approved', pullRequestEvidence)
  ).task;
  afterTask = (await move(ctx, after.group.id, afterTask, 'reviewer', 'merging', [])).task;
  afterTask = (
    await move(
      ctx,
      after.group.id,
      afterTask,
      'reviewer',
      'verifying_after_merge',
      pullRequestEvidence
    )
  ).task;
  await move(ctx, after.group.id, afterTask, 'verifier', 'done', passingCheckEvidence);

  const both = await startGroup(ctx, 'both', 'Check the branch and the merge.');
  let bothTask = (await addChild(ctx, both.group.id, 'both', 'Store both checks')).task;
  const bothRoot = await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: both.group.id,
    taskId: both.root.id,
    expectedVersion: both.root.version,
    actor: ctx.actor('planner'),
    to: 'implementing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });
  bothTask = (await move(ctx, both.group.id, bothTask, 'implementer', 'implementing', [])).task;
  bothTask = (
    await move(ctx, both.group.id, bothTask, 'implementer', 'in_review', pullRequestEvidence)
  ).task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'implementing', [])).task;
  bothTask = (
    await move(ctx, both.group.id, bothTask, 'implementer', 'in_review', pullRequestEvidence)
  ).task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'approved', pullRequestEvidence))
    .task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'verifying_before_merge', []))
    .task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'verifier', 'implementing', [])).task;
  expect(bothTask.state).toBe('implementing');
  bothTask = (
    await move(ctx, both.group.id, bothTask, 'implementer', 'in_review', pullRequestEvidence)
  ).task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'approved', pullRequestEvidence))
    .task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'verifying_before_merge', []))
    .task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'verifier', 'merging', passingCheckEvidence))
    .task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'implementing', [])).task;
  bothTask = (
    await move(ctx, both.group.id, bothTask, 'implementer', 'in_review', pullRequestEvidence)
  ).task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'approved', pullRequestEvidence))
    .task;
  const deferred = await move(
    ctx,
    both.group.id,
    bothTask,
    'reviewer',
    'merging',
    [],
    'after_merge'
  );
  expect(deferred.task.verification_mode).toBe('after_merge');
  bothTask = deferred.task;
  bothTask = (
    await move(
      ctx,
      both.group.id,
      bothTask,
      'reviewer',
      'verifying_after_merge',
      pullRequestEvidence
    )
  ).task;
  const bounced = await move(ctx, both.group.id, bothTask, 'verifier', 'implementing', []);
  expect(bounced.task.changeset_round).toBe(2);
  bothTask = (
    await move(ctx, both.group.id, bounced.task, 'implementer', 'in_review', pullRequestEvidence)
  ).task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'approved', pullRequestEvidence))
    .task;
  bothTask = (await move(ctx, both.group.id, bothTask, 'reviewer', 'merging', [])).task;
  bothTask = (
    await move(
      ctx,
      both.group.id,
      bothTask,
      'reviewer',
      'verifying_after_merge',
      pullRequestEvidence
    )
  ).task;
  await move(ctx, both.group.id, bothTask, 'verifier', 'done', passingCheckEvidence);
  return bothRoot;
}

async function walkFailed(
  ctx: Walk,
  before: { group: { id: GroupId } },
  bothRoot: { task: { state: string } }
): Promise<void> {
  const solo = await startGroup(ctx, null, 'The planner finishes alone.');
  const soloDone = await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: solo.group.id,
    taskId: solo.root.id,
    expectedVersion: solo.root.version,
    actor: ctx.actor('planner'),
    to: 'done',
    note,
    evidence: pullRequestEvidence,
    nextVerificationMode: null,
  });
  expect(soloDone.task.state).toBe('done');
  expect(soloDone.group.status).toBe('closed');

  const failed = await startGroup(ctx, null, 'Stop this goal.');
  const failedChild = await addChild(ctx, failed.group.id, null, 'Work to abandon');
  const failedRoot = await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: failed.group.id,
    taskId: failed.root.id,
    expectedVersion: failed.root.version,
    actor: ctx.actor('planner'),
    to: 'implementing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });
  const abandoned = await reportTransition(ctx.deps, {
    workspaceId: ctx.workspaceId,
    groupId: failed.group.id,
    taskId: failedRoot.task.id,
    expectedVersion: failedRoot.task.version,
    actor: { kind: 'person', personId: ctx.admin.id },
    to: 'failed',
    note: 'The goal is no longer worth the budget.',
    evidence: [],
    nextVerificationMode: null,
  });
  const failedTasks = await ctx.deps.store.tasks(ctx.workspaceId, failed.group.id);
  const childAfter = failedTasks.find(task => task.id === failedChild.task.id);

  expect(abandoned.task.state).toBe('failed');
  expect(abandoned.group.status).toBe('closed');
  expect(childAfter?.state).toBe('failed');
  expect(
    (await ctx.deps.store.events(ctx.workspaceId, failed.group.id)).some(
      event => event.task_id === failedChild.task.id && event.note === 'root task failed'
    )
  ).toBe(true);

  expect(await ctx.deps.store.group(ctx.deps.ids.workspace(), before.group.id)).toBeNull();
  await expectInvariants(ctx.db, ctx.workspaceId);
  expect(bothRoot.task.state).toBe('implementing');
}

test('a new database has none of the product tables', async () => {
  const db = await openEmptyDatabase();
  const found = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('workspaces', 'groups', 'tasks', 'task_events')`
  );

  expect(found.rows[0]?.count).toBe(0);
});
test('the migration files apply once to an empty database', async () => {
  const db = await openEmptyDatabase();
  const deps = createTestDeps(db, { random: fixedRandom(7) });
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();

  await deps.store.migrate();
  await deps.store.migrate();

  const applied = await db.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name'
  );

  const workspaces = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM workspaces`
  );

  expect(applied.rows.map(row => row.name)).toEqual(files);
  expect(workspaces.rows[0]?.count).toBe(0);
});
test('the bootstrap key is shown once and creates the first local administrator', async () => {
  const db = await openMigratedDatabase();
  const deps = createTestDeps(db, { random: bootstrapRandom() });
  const opened = await openInstallation(deps);
  const again = await openInstallation(deps);
  const expectedSecret = `opk_${Buffer.from(new Uint8Array(32).fill(7)).toString('base64url')}`;

  expect(opened.workspace.id).toBe(defaultWorkspaceId);
  expect(opened.bootstrapSecret).toBe(expectedSecret);
  expect(again.bootstrapSecret).toBeNull();

  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  await expectHivemindError(
    createOperatorKey(deps, {
      bootstrapSecret: secret,
      name: 'daily',
      role: 'creator',
      expiresAt: null,
    }),
    'conflict'
  );

  const person = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });

  expect(person.workspace_role).toBe('administrator');
  expect(person.account_id).toBeNull();
  expect(person.display_name).toBe('Ada');
  expect(person.workspace_id).toBe(opened.workspace.id);

  await expectHivemindError(
    createFirstAdministrator(deps, { bootstrapSecret: secret, displayName: 'Ada again' }),
    'conflict'
  );

  const created = await createOperatorKey(deps, {
    bootstrapSecret: secret,
    name: 'daily',
    role: 'creator',
    expiresAt: null,
  });

  expect(created.secret.startsWith('opk_')).toBe(true);
  expect(created.record.person_id).toBe(person.id);
  expect(created.record.key_hash).toBe(createHash('sha256').update(created.secret).digest('hex'));
  expect(JSON.stringify(created.record)).not.toContain(created.secret);

  await expectHivemindError(
    createOperatorKey(deps, {
      bootstrapSecret: secret,
      name: 'nope',
      role: 'bootstrap',
      expiresAt: null,
    }),
    'validation_failed'
  );

  await expectInvariants(db, opened.workspace.id);
});
test('a person needs a display name a reader can see', async () => {
  const db = await openMigratedDatabase();
  const deps = createTestDeps(db, { random: bootstrapRandom() });
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  const blank = await expectHivemindError(
    createFirstAdministrator(deps, { bootstrapSecret: secret, displayName: ' \n\t ' }),
    'validation_failed'
  );
  const empty = await expectHivemindError(
    createFirstAdministrator(deps, { bootstrapSecret: secret, displayName: '' }),
    'validation_failed'
  );
  const tooLong = await expectHivemindError(
    createFirstAdministrator(deps, {
      bootstrapSecret: secret,
      displayName: ` ${'A'.repeat(201)} `,
    }),
    'validation_failed'
  );

  expect(blank.details.field).toBe('display_name');
  expect(empty.details.field).toBe('display_name');
  expect(tooLong.details.field).toBe('display_name');

  const person = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: `  ${'A'.repeat(200)}  `,
  });

  expect(person.display_name).toBe('A'.repeat(200));
});
test('the bootstrap key stops working 24 hours after it is created', async () => {
  const db = await openMigratedDatabase();
  const deps = createTestDeps(db, { random: fixedRandom(9) });
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  deps.clock.advance(dayMs);

  await expectHivemindError(
    createFirstAdministrator(deps, { bootstrapSecret: secret, displayName: 'Ada' }),
    'unauthenticated'
  );
});
test('an expired unused bootstrap key does not block a new one', async () => {
  const db = await openMigratedDatabase();
  let draw = 0;
  const deps = createTestDeps(db, {
    random: {
      bytes(length) {
        draw += 1;

        return new Uint8Array(length).fill(draw);
      },
    },
  });
  const opened = await openInstallation(deps);
  const first = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  deps.clock.advance(dayMs);

  const again = await openInstallation(deps);
  const second = requirePresent(again.bootstrapSecret, 'expected a replacement bootstrap secret');

  expect(second).not.toBe(first);
  await expectHivemindError(
    createFirstAdministrator(deps, { bootstrapSecret: first, displayName: 'Ada' }),
    'unauthenticated'
  );

  const person = await createFirstAdministrator(deps, {
    bootstrapSecret: second,
    displayName: 'Ada',
  });
  const quiet = await openInstallation(deps);

  expect(person.display_name).toBe('Ada');
  expect(quiet.bootstrapSecret).toBeNull();
});
test('a group walks every permitted path, and a closed task stays closed', async () => {
  const ctx = await prepareWalk();
  const before = await walkBefore(ctx);
  const bothRoot = await walkAfter(ctx);
  await walkFailed(ctx, before, bothRoot);
});

test('a budget never drops below spend except by a recorded administrator correction', async () => {
  const { db, deps } = await openMigratedDatabaseWithDeps();
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });
  const memberId = deps.ids.person();
  await db.query(
    `INSERT INTO people (id, workspace_id, display_name, workspace_role, account_id, status, created_at)
       VALUES ($1, $2, 'Member', 'member', NULL, 'active', $3)`,
    [memberId, opened.workspace.id, '2026-11-16T00:00:00.000Z']
  );

  const created = await createGroup(deps, {
    workspaceId: opened.workspace.id,
    personId: memberId,
    name: 'Member goal',
    goal: 'Spend carefully.',
    budget: '10',
    connectionId: deps.ids.connection(),
    verificationMode: null,
    notes: [],
  });

  await db.query(`UPDATE groups SET spend = 5 WHERE id = $1`, [created.group.id]);

  await expectHivemindError(
    raiseBudget(deps, {
      workspaceId: opened.workspace.id,
      groupId: created.group.id,
      personId: memberId,
      budget: '4',
      note: 'Too low.',
    }),
    'validation_failed'
  );
  await expectHivemindError(
    correctBudget(deps, {
      workspaceId: opened.workspace.id,
      groupId: created.group.id,
      personId: memberId,
      budget: '5',
      note: 'A member cannot correct the budget.',
    }),
    'forbidden'
  );

  const raised = await raiseBudget(deps, {
    workspaceId: opened.workspace.id,
    groupId: created.group.id,
    personId: memberId,
    budget: '12',
    note: 'More room for the work.',
  });
  expect(raised.budget).toBe('12');

  await expectHivemindError(
    correctBudget(deps, {
      workspaceId: opened.workspace.id,
      groupId: created.group.id,
      personId: admin.id,
      budget: '4',
      note: 'Below the spend already recorded.',
    }),
    'validation_failed'
  );

  const corrected = await correctBudget(deps, {
    workspaceId: opened.workspace.id,
    groupId: created.group.id,
    personId: admin.id,
    budget: '5',
    note: 'Bring the ceiling down to the spend.',
  });

  expect(corrected.budget).toBe('5');
  const correction = (await deps.store.events(opened.workspace.id, created.group.id)).find(
    event => event.kind === 'owner_instruction' && event.data.instruction === 'correct_budget'
  );
  expect(correction?.actor_id).toBe(admin.id);
  expect(correction?.data.budget_after).toBe('5');

  await expectInvariants(db, opened.workspace.id);
});
test('the database keeps one root task and refuses to rewrite an event', async () => {
  const { db, deps } = await openMigratedDatabaseWithDeps();
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');
  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });
  const created = await createGroup(deps, {
    workspaceId: opened.workspace.id,
    personId: admin.id,
    name: 'One root',
    goal: 'Keep a single root task.',
    budget: '3',
    connectionId: deps.ids.connection(),
    verificationMode: null,
    notes: [],
  });

  let secondRootFailed = false;
  try {
    await db.query(
      `INSERT INTO tasks (
           id, workspace_id, group_id, parent_id, title, description, state, state_entered_at,
           verification_mode, changeset_id, depends_on, changeset_round, respawns_used,
           created_by_kind, created_by_id, created_at, closed_at, version
         )
         SELECT
           'tsk_ABCDEFGHJKMNPQRSTVWXYZ2345',
           workspace_id, group_id, parent_id, title, description, state, state_entered_at,
           verification_mode, changeset_id, depends_on, changeset_round, respawns_used,
           created_by_kind, created_by_id, created_at, closed_at, version
         FROM tasks
         WHERE parent_id IS NULL
         LIMIT 1`
    );
  } catch {
    secondRootFailed = true;
  }

  expect(secondRootFailed).toBe(true);

  const eventId = (await deps.store.events(opened.workspace.id, created.group.id))[0]?.id;
  expect(eventId).toBeDefined();

  let rewriteFailed = false;
  try {
    await db.query(`UPDATE task_events SET note = 'changed' WHERE id = $1`, [eventId]);
  } catch {
    rewriteFailed = true;
  }

  expect(rewriteFailed).toBe(true);
});

test('the root closes when it enters implementing after every child is done', async () => {
  const { deps } = await openMigratedDatabaseWithDeps();
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });
  const workspaceId = opened.workspace.id;
  const planner = deps.ids.session();
  const implementer = deps.ids.session();
  const reviewer = deps.ids.session();
  const verifier = deps.ids.session();
  const created = await createGroup(deps, {
    workspaceId,
    personId: admin.id,
    name: 'Late root',
    goal: 'Finish the children before the root leaves analysis.',
    budget: '10',
    connectionId: deps.ids.connection(),
    verificationMode: 'before_merge',
    notes: [],
  });
  const analyzed = await reportTransition(deps, {
    workspaceId,
    groupId: created.group.id,
    taskId: created.root.id,
    expectedVersion: created.root.version,
    actor: { kind: 'session', role: 'planner', sessionId: planner, live: true },
    to: 'analyzing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });
  let child = (
    await createChildTask(deps, {
      workspaceId,
      groupId: created.group.id,
      actor: { sessionId: planner, live: true },
      title: 'Finish first',
      description: 'Complete this child while the root is still analyzing.',
      verificationMode: null,
      dependsOn: [],
    })
  ).task;
  const steps: {
    role: 'implementer' | 'reviewer' | 'verifier';
    to: TaskState;
    evidence: EvidenceEntry[];
  }[] = [
    { role: 'implementer', to: 'implementing', evidence: [] },
    { role: 'implementer', to: 'in_review', evidence: pullRequestEvidence },
    { role: 'reviewer', to: 'approved', evidence: pullRequestEvidence },
    { role: 'reviewer', to: 'verifying_before_merge', evidence: [] },
    { role: 'verifier', to: 'merging', evidence: passingCheckEvidence },
    { role: 'reviewer', to: 'done', evidence: pullRequestEvidence },
  ];
  const sessions = { implementer, reviewer, verifier };

  for (const step of steps) {
    child = (
      await reportTransition(deps, {
        workspaceId,
        groupId: created.group.id,
        taskId: child.id,
        expectedVersion: child.version,
        actor: { kind: 'session', role: step.role, sessionId: sessions[step.role], live: true },
        to: step.to,
        note,
        evidence: step.evidence,
        nextVerificationMode: null,
      })
    ).task;
  }

  const rootBefore = (await deps.store.tasks(workspaceId, created.group.id)).find(
    task => task.parent_id === null
  );
  expect(rootBefore?.state).toBe('analyzing');
  expect((await deps.store.group(workspaceId, created.group.id))?.status).toBe('open');

  const moved = await reportTransition(deps, {
    workspaceId,
    groupId: created.group.id,
    taskId: created.root.id,
    expectedVersion: rootBefore?.version ?? analyzed.task.version,
    actor: { kind: 'session', role: 'planner', sessionId: planner, live: true },
    to: 'implementing',
    note,
    evidence: [],
    nextVerificationMode: null,
  });
  const root = (await deps.store.tasks(workspaceId, created.group.id)).find(
    task => task.parent_id === null
  );

  expect(moved.task.state).toBe('done');
  expect(root?.state).toBe('done');
  expect((await deps.store.group(workspaceId, created.group.id))?.status).toBe('closed');
});
test('saved platform settings come back on read', async () => {
  const { deps } = await openMigratedDatabaseWithDeps();
  const opened = await openInstallation(deps);
  const secret = requirePresent(opened.bootstrapSecret, 'expected a bootstrap secret');

  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });
  const group: Group = {
    id: deps.ids.group(),
    workspace_id: opened.workspace.id,
    name: 'Settings group',
    goal: 'Keep the platform settings.',
    owner_person_id: admin.id,
    default_verification_mode: 'before_merge',
    connection_id: deps.ids.connection(),
    budget: '10',
    spend: '0',
    caps: selfHostedGroupCaps,
    session_settings: {
      model_tier: 'strong',
      repositories: ['acme/app'],
      platform_settings: { memory: true, organization: 'acme' },
      role_tiers: { planner: 'strong' },
    },
    context_fingerprint: fingerprintText(''),
    features: [],
    initiator: null,
    status: 'open',
    created_at: '2026-11-16T00:00:00.000Z',
    closed_at: null,
  };

  await deps.store.transact(async tx => {
    await tx.insertGroup(group);
  });

  const read = await deps.store.group(opened.workspace.id, group.id);

  expect(read?.session_settings).toEqual(group.session_settings);
});
