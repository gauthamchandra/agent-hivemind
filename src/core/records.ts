import type { ReportActor, ServiceDeps } from '@/core/deps.ts';
import { requireContextNotes } from '@/domain/context.ts';
import { compareDecimal, requirePositiveDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  type ConnectionId,
  type GroupId,
  type PersonId,
  requireGroupId,
  requireTaskId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
} from '@/domain/ids.ts';
import type {
  EvidenceEntry,
  Group,
  Person,
  SessionRecord,
  Task,
  TaskEvent,
  TaskState,
  VerificationMode,
} from '@/domain/model.ts';
import { emptySessionSettings, isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { TransitionActor } from '@/domain/transitions.ts';
import { decideTransition } from '@/domain/transitions.ts';
import { evaluatePolicy } from '@/policy/policy.ts';
import type { IdempotencyRecord, UnitOfWork } from '@/ports/storage.ts';

const serviceId = 'hivemind-svc';

export type StoredActor = { kind: 'session' | 'person' | 'service'; id: string };

type IdempotencyInput = {
  key: string;
  bodyHash: string;
  callerKind: string;
  callerId: string;
  route: string;
};

export async function createGroup(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    personId: PersonId;
    name: string;
    goal: string;
    budget: string;
    connectionId: ConnectionId;
    verificationMode: VerificationMode | null;
    notes: { name: string; body: string }[];
    idempotency?: IdempotencyInput;
  }
): Promise<{ group: Group; root: Task; replay: boolean }> {
  return deps.store.transact(async tx => {
    const workspace = await tx.lockWorkspace(input.workspaceId);

    if (workspace === null) {
      throw new HivemindError('not_found', 'No workspace with that identifier exists.');
    }

    const replayed = await replayedGroup(tx, input.workspaceId, input.idempotency);

    if (replayed) return replayed;

    const person = await requireActivePerson(tx, input.workspaceId, input.personId);

    const name = requireGroupName(input.name);
    const goal = requireBoundedText(input.goal, 'goal', 32 * 1024);
    const budget = requirePositiveDecimal(input.budget);
    const notes = requireContextNotes(input.notes);
    const now = formatTime(deps.clock.now());
    const mode = input.verificationMode ?? 'before_merge';
    const group: Group = {
      id: deps.ids.group(),
      workspace_id: input.workspaceId,
      name,
      goal,
      owner_person_id: person.id,
      default_verification_mode: mode,
      connection_id: input.connectionId,
      budget,
      spend: '0',
      caps: workspace.limits.default_group_caps,
      session_settings: emptySessionSettings,
      context_fingerprint: notes.fingerprint,
      features: [],
      initiator: null,
      status: 'open',
      created_at: now,
      closed_at: null,
    };
    const root: Task = {
      id: deps.ids.task(),
      workspace_id: input.workspaceId,
      group_id: group.id,
      parent_id: null,
      title: name,
      description: goal,
      state: 'planned',
      state_entered_at: now,
      verification_mode: mode,
      changeset_id: null,
      depends_on: [],
      changeset_round: 1,
      respawns_used: 0,
      created_by_kind: 'person',
      created_by_id: person.id,
      created_at: now,
      closed_at: null,
      version: 1,
    };

    await tx.insertGroup(group);
    await tx.insertNotes(
      notes.notes.map((note, position) => ({
        workspace_id: input.workspaceId,
        group_id: group.id,
        position,
        name: note.name,
        body: note.body,
      }))
    );
    await tx.insertTask(root);
    await appendEvent(deps, tx, {
      workspace_id: input.workspaceId,
      task_id: root.id,
      group_id: group.id,
      kind: 'created',
      actor: { kind: 'person', id: person.id },
      from_state: null,
      to_state: 'planned',
      evidence: [],
      note: null,
      data: {},
    });

    if (input.idempotency) {
      await rememberIdempotency(tx, input.workspaceId, input.idempotency, group.id, now, {
        group,
        root,
      });
    }

    return { group, root, replay: false };
  });
}

export async function createChildTask(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    groupId: GroupId;
    actor: { role: 'planner'; sessionId: SessionId; live: boolean };
    title: string;
    description: string;
    verificationMode: VerificationMode | null;
    dependsOn: TaskId[];
    idempotency?: IdempotencyInput;
  }
): Promise<{ task: Task }> {
  return deps.store.transact(async tx => {
    const group = await requireGroup(tx, input.workspaceId, input.groupId);
    const root = await requireRoot(tx, input.workspaceId, input.groupId);
    const replayed = await replayedTask(tx, input.workspaceId, input.idempotency);

    if (replayed) return { task: replayed };

    const session = await lockedCaller(tx, input.workspaceId, input.actor.sessionId);

    if (session !== null && session.group_id !== group.id) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

    const decision = evaluatePolicy({
      role: session?.role ?? 'planner',
      action: 'create_child_task',
      released: session === null ? !input.actor.live : session.life === 'released',
      taskKind: 'root',
      taskState: root.state,
      relation: 'own',
      rootState: root.state,
      targetRole: 'planner',
      targetStartedByCaller: false,
      targetTaskClosed: false,
    });

    if (!decision.allowed) {
      throw new HivemindError('policy_denied', decision.message, {
        role: decision.role,
        action: decision.action,
      });
    }

    const title = requireTitle(input.title);
    const description = requireBoundedText(input.description, 'description', 32 * 1024);
    const siblings = await tx.tasks(input.workspaceId, input.groupId);

    for (const dependency of input.dependsOn) {
      const found = siblings.some(task => task.id === dependency && task.parent_id !== null);

      if (!found) {
        throw new HivemindError(
          'validation_failed',
          'A dependency must be a child task in this group.',
          {
            field: 'depends_on',
          }
        );
      }
    }

    const now = formatTime(deps.clock.now());
    const task: Task = {
      id: deps.ids.task(),
      workspace_id: input.workspaceId,
      group_id: group.id,
      parent_id: root.id,
      title,
      description,
      state: 'planned',
      state_entered_at: now,
      verification_mode: input.verificationMode ?? group.default_verification_mode,
      changeset_id: null,
      depends_on: input.dependsOn,
      changeset_round: 1,
      respawns_used: 0,
      created_by_kind: 'session',
      created_by_id: input.actor.sessionId,
      created_at: now,
      closed_at: null,
      version: 1,
    };

    await tx.insertTask(task);
    await appendEvent(deps, tx, {
      workspace_id: input.workspaceId,
      task_id: task.id,
      group_id: group.id,
      kind: 'created',
      actor: { kind: 'session', id: input.actor.sessionId },
      from_state: null,
      to_state: 'planned',
      evidence: [],
      note: null,
      data: {},
    });

    if (input.idempotency) {
      await rememberIdempotency(tx, input.workspaceId, input.idempotency, task.id, now, { task });
    }

    return { task };
  });
}

export async function reportTransition(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    groupId: GroupId;
    taskId: TaskId;
    expectedVersion: number;
    actor: ReportActor;
    to: TaskState;
    note: string;
    evidence: EvidenceEntry[];
    nextVerificationMode: VerificationMode | null;
    idempotency?: {
      key: string;
      bodyHash: string;
      callerKind: string;
      callerId: string;
      route: string;
    };
  }
): Promise<{ task: Task; group: Group }> {
  return deps.store.transact(async tx => {
    const group = await requireGroup(tx, input.workspaceId, input.groupId);
    const root = await requireRoot(tx, input.workspaceId, input.groupId);
    const task = await requireTask(tx, input.workspaceId, input.taskId, input.groupId);
    const idempotency = input.idempotency;

    if (idempotency) {
      const existing = await tx.findIdempotency(
        input.workspaceId,
        idempotency.callerKind,
        idempotency.callerId,
        idempotency.route,
        idempotency.key
      );

      if (existing) {
        if (existing.body_hash !== idempotency.bodyHash) {
          throw new HivemindError(
            'idempotency_conflict',
            'That idempotency key was used with a different body.'
          );
        }

        return storedTransition(existing.response) ?? { task, group };
      }
    }

    if (task.version !== input.expectedVersion) {
      throw new HivemindError('conflict', 'The task changed since it was read.', {
        version: task.version,
        state: task.state,
      });
    }

    const actor = await resolveActor(tx, input.workspaceId, group, input.actor);

    if (actor.caller) {
      requireReporterTask(actor.caller, task, root, input.to, input.nextVerificationMode);
    }

    const applied = await applyReport(deps, tx, group, task, actor.transition, actor.stored, {
      to: input.to,
      note: input.note,
      evidence: input.evidence,
      nextVerificationMode: input.nextVerificationMode,
    });

    const childClosed = task.parent_id !== null && isClosedState(applied.task.state);
    const rootEnteredImplementing =
      task.parent_id === null && applied.task.state === 'implementing';

    const result =
      childClosed || rootEnteredImplementing
        ? await finishedRoot(deps, tx, applied, rootEnteredImplementing)
        : applied;

    if (input.actor.kind === 'session') {
      await tx.touchReport(input.actor.sessionId, formatTime(deps.clock.now()));
    }

    if (idempotency) {
      await tx.insertIdempotency({
        workspaceId: input.workspaceId,
        callerKind: idempotency.callerKind,
        callerId: idempotency.callerId,
        route: idempotency.route,
        key: idempotency.key,
        bodyHash: idempotency.bodyHash,
        recordId: result.task.id,
        completed: true,
        response: { task: result.task, group: result.group },
        at: formatTime(deps.clock.now()),
      });
    }

    return result;
  });
}

async function finishedRoot(
  deps: ServiceDeps,
  tx: UnitOfWork,
  applied: { task: Task; group: Group },
  rootEnteredImplementing: boolean
): Promise<{ task: Task; group: Group }> {
  const closed = await closeRootWhenChildrenDone(deps, tx, applied.group);

  if (rootEnteredImplementing) return closed;

  return { task: applied.task, group: closed.group };
}

export async function raiseBudget(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    groupId: GroupId;
    personId: PersonId;
    budget: string;
    note: string;
  }
): Promise<Group> {
  return changeBudget(deps, input, 'raise');
}

export async function correctBudget(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    groupId: GroupId;
    personId: PersonId;
    budget: string;
    note: string;
  }
): Promise<Group> {
  return changeBudget(deps, input, 'correct');
}

async function changeBudget(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    groupId: GroupId;
    personId: PersonId;
    budget: string;
    note: string;
  },
  kind: 'raise' | 'correct'
): Promise<Group> {
  return deps.store.transact(async tx => {
    const group = await requireGroup(tx, input.workspaceId, input.groupId);
    const person = await requireActivePerson(tx, input.workspaceId, input.personId);
    const owner = person.id === group.owner_person_id;
    const administrator = person.workspace_role === 'administrator';
    const next = requirePositiveDecimal(input.budget);
    const note = requireBoundedText(input.note, 'note', 4 * 1024);

    if (kind === 'raise' && !owner && !administrator) {
      throw new HivemindError(
        'forbidden',
        'Only the owner or an administrator can raise the budget.'
      );
    }

    if (kind === 'correct' && !administrator) {
      throw new HivemindError('forbidden', 'Only an administrator can correct the budget.');
    }

    if (kind === 'raise' && compareDecimal(next, group.budget) <= 0) {
      throw new HivemindError(
        'validation_failed',
        'A budget can only increase, unless an administrator corrects it.',
        {
          field: 'budget',
        }
      );
    }

    if (kind === 'correct' && compareDecimal(next, group.spend) < 0) {
      throw new HivemindError(
        'validation_failed',
        'A budget cannot drop below the spend already recorded.',
        {
          field: 'budget',
        }
      );
    }

    if (compareDecimal(next, group.budget) === 0) {
      throw new HivemindError('validation_failed', 'The budget is already that amount.', {
        field: 'budget',
      });
    }

    const updated: Group = { ...group, budget: next };
    const root = await requireRoot(tx, input.workspaceId, input.groupId);

    await tx.updateGroup(updated);
    await appendEvent(deps, tx, {
      workspace_id: input.workspaceId,
      task_id: root.id,
      group_id: group.id,
      kind: 'owner_instruction',
      actor: { kind: 'person', id: person.id },
      from_state: null,
      to_state: null,
      evidence: [],
      note,
      data: {
        instruction: kind === 'raise' ? 'raise_budget' : 'correct_budget',
        budget_before: group.budget,
        budget_after: next,
        spend: group.spend,
      },
    });

    return updated;
  });
}

async function applyReport(
  deps: ServiceDeps,
  tx: UnitOfWork,
  group: Group,
  task: Task,
  actor: TransitionActor,
  stored: StoredActor,
  report: {
    to: TaskState;
    note: string;
    evidence: EvidenceEntry[];
    nextVerificationMode: VerificationMode | null;
  }
): Promise<{ task: Task; group: Group }> {
  const counts = await tx.childCounts(task.workspace_id, task.group_id);
  const decision = decideTransition({
    taskKind: task.parent_id === null ? 'root' : 'child',
    from: task.state,
    to: report.to,
    verificationMode: task.verification_mode,
    nextVerificationMode: report.nextVerificationMode,
    actor,
    note: report.note,
    evidence: report.evidence,
    childCount: counts.childCount,
    openChildCount: counts.openChildCount,
    failedChildCount: counts.failedChildCount,
    implementerEverStarted: await tx.implementerEverStarted(task.group_id),
  });

  if (!decision.ok) {
    throw new HivemindError(decision.code, decision.message, decision.details);
  }

  const now = formatTime(deps.clock.now());
  let version = task.version;
  let mode = task.verification_mode;

  if (decision.modeChanged) {
    version += 1;
    const previous = mode;
    mode = decision.verificationMode;
    await appendEvent(deps, tx, {
      workspace_id: task.workspace_id,
      task_id: task.id,
      group_id: task.group_id,
      kind: 'verification_mode_changed',
      actor: stored,
      from_state: task.state,
      to_state: task.state,
      evidence: report.evidence,
      note: report.note,
      data: { verification_mode_before: previous, verification_mode_after: mode },
    });
  }

  version += 1;
  const closed = isClosedState(decision.to);
  const updated: Task = {
    ...task,
    state: decision.to,
    state_entered_at: now,
    verification_mode: mode,
    changeset_round: task.changeset_round + (decision.incrementChangesetRound ? 1 : 0),
    version,
    closed_at: closed ? now : task.closed_at,
  };

  await tx.updateTask(updated);
  await appendEvent(deps, tx, {
    workspace_id: task.workspace_id,
    task_id: task.id,
    group_id: task.group_id,
    kind: 'transition',
    actor: stored,
    from_state: task.state,
    to_state: decision.to,
    evidence: report.evidence,
    note: report.note,
    data: {},
  });

  let current = group;

  if (task.parent_id === null && closed) {
    current = { ...group, status: 'closed', closed_at: now };
    await tx.updateGroup(current);
  }

  if (task.parent_id === null && decision.to === 'failed') {
    const children = await tx.openChildren(task.workspace_id, task.group_id, task.id);

    for (const child of children) {
      const failed: Task = {
        ...child,
        state: 'failed',
        state_entered_at: now,
        version: child.version + 1,
        closed_at: now,
      };

      await tx.updateTask(failed);
      await appendEvent(deps, tx, {
        workspace_id: child.workspace_id,
        task_id: child.id,
        group_id: child.group_id,
        kind: 'transition',
        actor: stored,
        from_state: child.state,
        to_state: 'failed',
        evidence: [],
        note: 'root task failed',
        data: {},
      });
    }
  }

  return { task: updated, group: current };
}

async function closeRootWhenChildrenDone(
  deps: ServiceDeps,
  tx: UnitOfWork,
  group: Group
): Promise<{ task: Task; group: Group }> {
  const root = await requireRoot(tx, group.workspace_id, group.id);

  if (root.state !== 'implementing') return { task: root, group };

  const counts = await tx.childCounts(group.workspace_id, group.id);
  const decision = decideTransition({
    taskKind: 'root',
    from: root.state,
    to: 'done',
    verificationMode: root.verification_mode,
    nextVerificationMode: null,
    actor: { kind: 'service' },
    note: 'Every child task is done.',
    evidence: [],
    childCount: counts.childCount,
    openChildCount: counts.openChildCount,
    failedChildCount: counts.failedChildCount,
    implementerEverStarted: await tx.implementerEverStarted(group.id),
  });

  if (!decision.ok) return { task: root, group };

  return applyReport(
    deps,
    tx,
    group,
    root,
    { kind: 'service' },
    { kind: 'service', id: serviceId },
    {
      to: 'done',
      note: 'Every child task is done.',
      evidence: [],
      nextVerificationMode: null,
    }
  );
}

async function resolveActor(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  group: Group,
  actor: ReportActor
): Promise<{ transition: TransitionActor; stored: StoredActor; caller: SessionRecord | null }> {
  if (actor.kind === 'service') {
    return {
      transition: { kind: 'service' },
      stored: { kind: 'service', id: serviceId },
      caller: null,
    };
  }

  if (actor.kind === 'session') {
    const session = await lockedCaller(tx, workspaceId, actor.sessionId);

    if (session === null) {
      return {
        transition: { kind: 'session', role: actor.role, live: actor.live },
        stored: { kind: 'session', id: actor.sessionId },
        caller: null,
      };
    }

    if (session.group_id !== group.id) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

    return {
      transition: {
        kind: 'session',
        role: session.role,
        live: session.life === 'live' || session.life === 'starting',
      },
      stored: { kind: 'session', id: session.id },
      caller: session,
    };
  }

  const person = await requireActivePerson(tx, workspaceId, actor.personId);

  return {
    transition: {
      kind: 'person',
      owner: person.id === group.owner_person_id,
      administrator: person.workspace_role === 'administrator',
    },
    stored: { kind: 'person', id: person.id },
    caller: null,
  };
}

function requireReporterTask(
  session: SessionRecord,
  task: Task,
  root: Task,
  to: TaskState,
  nextVerificationMode: VerificationMode | null
): void {
  const input = {
    role: session.role,
    released: session.life === 'released',
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: session.task_id === task.id ? 'own' : 'other',
    rootState: root.state,
    targetRole: session.role,
    targetStartedByCaller: false,
    targetTaskClosed: isClosedState(task.state),
  } as const;
  const decision = evaluatePolicy({
    ...input,
    action: to === 'failed' ? 'fail_task' : 'report_transition',
  });

  if (!decision.allowed) {
    throw new HivemindError('policy_denied', decision.message, {
      role: decision.role,
      action: decision.action,
    });
  }

  if (nextVerificationMode === null || nextVerificationMode === task.verification_mode) return;

  const mode = evaluatePolicy({ ...input, action: 'move_verification_mode' });

  if (!mode.allowed) {
    throw new HivemindError('policy_denied', mode.message, {
      role: mode.role,
      action: mode.action,
    });
  }
}

export async function appendEvent(
  deps: ServiceDeps,
  tx: UnitOfWork,
  draft: {
    workspace_id: WorkspaceId;
    task_id: TaskId;
    group_id: GroupId;
    kind: TaskEvent['kind'];
    actor: StoredActor;
    from_state: TaskState | null;
    to_state: TaskState | null;
    evidence: EvidenceEntry[];
    note: string | null;
    data: TaskEvent['data'];
  }
): Promise<void> {
  const event: TaskEvent = {
    id: deps.ids.event(),
    workspace_id: draft.workspace_id,
    task_id: draft.task_id,
    group_id: draft.group_id,
    sequence: await tx.nextSequence(draft.group_id),
    kind: draft.kind,
    actor_kind: draft.actor.kind,
    actor_id: draft.actor.id,
    from_state: draft.from_state,
    to_state: draft.to_state,
    evidence: draft.evidence,
    note: draft.note,
    data: draft.data,
    at: formatTime(deps.clock.now()),
  };

  await tx.insertEvent(event);
}

async function lockedCaller(tx: UnitOfWork, workspaceId: WorkspaceId, sessionId: SessionId) {
  const session = await tx.lockSession(workspaceId, sessionId);

  if (session === null) return null;

  if (session.token_hash === null) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  if (session.life === 'ended' || session.life === 'start_failed') {
    throw new HivemindError('session_not_active', 'The session cannot act from this life.', {
      life: session.life,
    });
  }

  if (session.end_requested_at !== null) {
    throw new HivemindError(
      'session_not_active',
      'The session is ending and cannot start new work.',
      { life: session.life }
    );
  }

  return session;
}

async function replayedGroup(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput | undefined
): Promise<{ group: Group; root: Task; replay: true } | null> {
  const existing = await replayedRecord(tx, workspaceId, idempotency);

  if (existing === null) return null;

  const saved = storedTransition(existing.response);

  if (saved) return { group: saved.group, root: saved.task, replay: true };

  const recordId = existing.record_id;

  if (recordId === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const group = await tx.lockGroup(workspaceId, requireGroupId(recordId));

  if (group === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const root = await requireRoot(tx, workspaceId, group.id);

  return { group, root, replay: true };
}

async function replayedTask(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput | undefined
): Promise<Task | null> {
  const existing = await replayedRecord(tx, workspaceId, idempotency);

  if (existing === null) return null;

  const saved = storedTask(existing.response);

  if (saved) return saved;

  const recordId = existing.record_id;

  if (recordId === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  const task = await tx.lockTask(workspaceId, requireTaskId(recordId));

  if (task === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  return task;
}

async function replayedRecord(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput | undefined
): Promise<IdempotencyRecord | null> {
  if (idempotency === undefined) return null;

  const existing = await tx.findIdempotency(
    workspaceId,
    idempotency.callerKind,
    idempotency.callerId,
    idempotency.route,
    idempotency.key
  );

  if (existing === null) return null;

  if (existing.body_hash !== idempotency.bodyHash) {
    throw new HivemindError(
      'idempotency_conflict',
      'That idempotency key was used with a different body.'
    );
  }

  if (existing.record_id === null) {
    throw new HivemindError(
      'request_in_progress',
      'The first request with this key is not complete.'
    );
  }

  return existing;
}

async function rememberIdempotency(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  idempotency: IdempotencyInput,
  recordId: string,
  at: string,
  response: unknown = {}
): Promise<void> {
  await tx.insertIdempotency({
    workspaceId,
    callerKind: idempotency.callerKind,
    callerId: idempotency.callerId,
    route: idempotency.route,
    key: idempotency.key,
    bodyHash: idempotency.bodyHash,
    recordId,
    completed: true,
    response,
    at,
  });
}

function storedTransition(response: unknown): { task: Task; group: Group } | null {
  const task = storedTask(response) ?? storedNamedTask(response, 'root');
  const group = storedGroup(response);

  if (task === null || group === null) return null;

  return { task, group };
}

function storedTask(response: unknown): Task | null {
  return storedNamedTask(response, 'task');
}

function storedNamedTask(response: unknown, field: string): Task | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, field);

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const state = Reflect.get(value, 'state');
  const version = Reflect.get(value, 'version');

  if (typeof id !== 'string' || typeof state !== 'string' || typeof version !== 'number') {
    return null;
  }

  return value as Task;
}

function storedGroup(response: unknown): Group | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, 'group');

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const status = Reflect.get(value, 'status');

  if (typeof id !== 'string' || typeof status !== 'string') return null;

  return value as Group;
}

async function requireGroup(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  groupId: GroupId
): Promise<Group> {
  const group = await tx.lockGroup(workspaceId, groupId);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  return group;
}

async function requireTask(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  taskId: TaskId,
  groupId: GroupId
): Promise<Task> {
  const task = await tx.lockTask(workspaceId, taskId);

  if (task === null || task.group_id !== groupId) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  return task;
}

async function requireRoot(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  groupId: GroupId
): Promise<Task> {
  const tasks = await tx.tasks(workspaceId, groupId);
  const root = tasks.find(task => task.parent_id === null);

  if (root === undefined) {
    throw new HivemindError('unavailable', 'The group has no root task.');
  }

  const locked = await tx.lockTask(workspaceId, root.id);

  if (locked === null) {
    throw new HivemindError('unavailable', 'The group has no root task.');
  }

  return locked;
}

async function requireActivePerson(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  personId: PersonId
): Promise<Person> {
  const person = await tx.person(workspaceId, personId);

  if (person === null) {
    throw new HivemindError('not_found', 'No person with that identifier is in this workspace.');
  }

  if (person.status !== 'active') {
    throw new HivemindError('forbidden', 'That person is disabled.');
  }

  return person;
}

function requireGroupName(name: string): string {
  const words = name.split(/\s+/).filter(word => word.length > 0);

  if (name.length < 1 || name.length > 40 || words.length < 1 || words.length > 5) {
    throw new HivemindError(
      'validation_failed',
      'A group name is 1 to 5 words and at most 40 characters.',
      {
        field: 'name',
      }
    );
  }

  return name;
}

export function requireTitle(title: string): string {
  if (title.trim().length === 0 || title.length > 120) {
    throw new HivemindError('validation_failed', 'A task title is 1 to 120 characters.', {
      field: 'title',
    });
  }

  return title;
}

function requireBoundedText(value: string, field: string, maxBytes: number): string {
  if (value.trim().length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new HivemindError('validation_failed', `The ${field} is missing or too long.`, { field });
  }

  return value;
}
