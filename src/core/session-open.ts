import type { ServiceDeps } from '@/core/deps.ts';
import { createGroup } from '@/core/group-records.ts';
import { requireBoundedText } from '@/core/record-checks.ts';
import { reportTransition } from '@/core/report-records.ts';
import { storedOutcome } from '@/core/session-outcome.ts';
import { recoverPendingStart, startSession } from '@/core/session-start.ts';
import type { StartOutcome } from '@/core/session-types.ts';
import { type ErrorCode, errorCodes, HivemindError } from '@/domain/errors.ts';
import type { GroupId, PersonId, WorkspaceId } from '@/domain/ids.ts';
import type { Group, SessionRecord, Task, VerificationMode } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import type { PlatformErrorClass } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function openGroup(
  deps: ServiceDeps,
  platforms: Platforms,
  input: {
    workspaceId: WorkspaceId;
    personId: PersonId;
    name: string;
    goal: string;
    budget: string;
    connectionId: Group['connection_id'];
    verificationMode: VerificationMode | null;
    notes: { name: string; body: string }[];
    instructions: string;
    idempotencyKey: string;
    bodyHash: string;
  }
): Promise<{
  outcome: StartOutcome['outcome'];
  group: Group;
  root: Task;
  session: SessionRecord;
  errorClass?: PlatformErrorClass;
}> {
  requireBoundedText(input.instructions, 'instructions', 16 * 1024);

  const handle = platforms.require(input.connectionId);

  if (!handle.connection.capabilities.includes('usage_reading')) {
    throw new HivemindError('capability_missing', 'The connection does not report usage.', {
      capability: 'usage_reading',
    });
  }

  const created = await createGroup(deps, {
    workspaceId: input.workspaceId,
    personId: input.personId,
    name: input.name,
    goal: input.goal,
    budget: input.budget,
    connectionId: input.connectionId,
    verificationMode: input.verificationMode,
    notes: input.notes,
    idempotency: {
      key: input.idempotencyKey,
      bodyHash: input.bodyHash,
      callerKind: 'person',
      callerId: input.personId,
      route: 'group.open',
    },
  });

  if (created.replay) {
    const replayed = await replayedOpen(deps, platforms, input, created.group, created.root);

    if (replayed) return replayed;
  }

  const started = await startPlanner(deps, platforms, input, created.group, created.root);

  if (started.outcome !== 'refused') {
    return {
      outcome: started.outcome,
      group: created.group,
      root: created.root,
      session: started.session,
    };
  }

  const failed = await reportTransition(deps, {
    workspaceId: input.workspaceId,
    groupId: created.group.id,
    taskId: created.root.id,
    expectedVersion: created.root.version,
    actor: { kind: 'person', personId: input.personId },
    to: 'failed',
    note: 'The platform refused to start the planner.',
    evidence: [],
    nextVerificationMode: null,
  });

  return {
    outcome: 'refused',
    group: failed.group,
    root: failed.task,
    session: started.session,
    errorClass: started.errorClass ?? 'invalid',
  };
}

async function startPlanner(
  deps: ServiceDeps,
  platforms: Platforms,
  input: {
    workspaceId: WorkspaceId;
    personId: PersonId;
    instructions: string;
    idempotencyKey: string;
    bodyHash: string;
  },
  group: Group,
  root: Task
): Promise<StartOutcome> {
  try {
    return await startSession(deps, platforms, {
      workspaceId: input.workspaceId,
      groupId: group.id,
      taskId: root.id,
      role: 'planner',
      instructions: input.instructions,
      actor: { kind: 'person', personId: input.personId },
      idempotencyKey: `${input.idempotencyKey}:planner`,
      bodyHash: input.bodyHash,
      replacementOf: null,
    });
  } catch (error) {
    await closeGroupWithoutPlanner(deps, input, group);

    const named =
      error instanceof HivemindError
        ? new HivemindError(error.code, `${error.message} Group ${group.id} was closed.`, {
            ...error.details,
            group_id: group.id,
          })
        : error;

    await rememberOpenFailure(deps, input, group.id, named);

    throw named;
  }
}

async function replayedOpen(
  deps: ServiceDeps,
  platforms: Platforms,
  input: { workspaceId: WorkspaceId; personId: PersonId; idempotencyKey: string },
  group: Group,
  root: Task
): Promise<{
  outcome: StartOutcome['outcome'];
  group: Group;
  root: Task;
  session: SessionRecord;
  errorClass?: PlatformErrorClass;
} | null> {
  const sessions = await deps.store.sessions(input.workspaceId, group.id);
  const planner = sessions.find(session => session.role === 'planner');

  if (planner) {
    const settled = await recoverPendingStart(deps, platforms, planner);

    if (settled.life === 'start_failed') {
      await closeGroupWithoutPlanner(deps, input, group);
    }

    const outcome = await storedOutcome(deps, settled);
    const current = (await deps.store.group(input.workspaceId, group.id)) ?? group;
    const tasks = await deps.store.tasks(input.workspaceId, group.id);
    const liveRoot = tasks.find(task => task.parent_id === null) ?? root;

    return { ...outcome, group: current, root: liveRoot };
  }

  const remembered = await rememberedOpenFailure(deps, input);

  if (remembered) throw remembered;

  return null;
}

async function closeGroupWithoutPlanner(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; personId: PersonId },
  group: Group
): Promise<void> {
  const sessions = await deps.store.sessions(input.workspaceId, group.id);

  if (sessions.some(session => session.role === 'planner' && session.life !== 'start_failed')) {
    return;
  }

  const current = await deps.store.group(input.workspaceId, group.id);
  const tasks = await deps.store.tasks(input.workspaceId, group.id);
  const liveRoot = tasks.find(task => task.parent_id === null);

  if (
    current === null ||
    current.status !== 'open' ||
    liveRoot === undefined ||
    isClosedState(liveRoot.state)
  ) {
    return;
  }

  await reportTransition(deps, {
    workspaceId: input.workspaceId,
    groupId: group.id,
    taskId: liveRoot.id,
    expectedVersion: liveRoot.version,
    actor: { kind: 'person', personId: input.personId },
    to: 'failed',
    note: 'The planner did not start.',
    evidence: [],
    nextVerificationMode: null,
  });
}

const openFailureRoute = 'group.open.failure';

async function rememberedOpenFailure(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; personId: PersonId; idempotencyKey: string }
): Promise<HivemindError | null> {
  const row = await deps.store.transact(tx =>
    tx.findIdempotency(
      input.workspaceId,
      'person',
      input.personId,
      openFailureRoute,
      input.idempotencyKey
    )
  );

  return failureFrom(row?.response);
}

async function rememberOpenFailure(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    personId: PersonId;
    idempotencyKey: string;
    bodyHash: string;
  },
  groupId: GroupId,
  error: unknown
): Promise<void> {
  if (!(error instanceof HivemindError)) return;

  await deps.store.transact(async tx => {
    const existing = await tx.findIdempotency(
      input.workspaceId,
      'person',
      input.personId,
      openFailureRoute,
      input.idempotencyKey
    );

    if (existing) return;

    await tx.insertIdempotency({
      workspaceId: input.workspaceId,
      callerKind: 'person',
      callerId: input.personId,
      route: openFailureRoute,
      key: input.idempotencyKey,
      bodyHash: input.bodyHash,
      recordId: groupId,
      response: { code: error.code, message: error.message, details: error.details },
      completed: true,
      at: formatTime(deps.clock.now()),
    });
  });
}

function failureFrom(response: unknown): HivemindError | null {
  if (typeof response !== 'object' || response === null) return null;

  const code = Reflect.get(response, 'code');
  const message = Reflect.get(response, 'message');
  const details = Reflect.get(response, 'details');

  if (typeof code !== 'string' || !(errorCodes as readonly string[]).includes(code)) return null;
  if (typeof message !== 'string') return null;
  if (typeof details !== 'object' || details === null) return null;

  const safe: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' || typeof value === 'number') safe[key] = value;
  }

  return new HivemindError(code as ErrorCode, message, safe);
}
