import type { ReportActor, ServiceDeps } from '@/core/deps.ts';
import { requireContextNotes } from '@/domain/context.ts';
import { compareDecimal, requirePositiveDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import type {
  ConnectionId,
  GroupId,
  PersonId,
  SessionId,
  TaskId,
  WorkspaceId,
} from '@/domain/ids.ts';
import type {
  EvidenceEntry,
  Group,
  Person,
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
import type { UnitOfWork } from '@/ports/storage.ts';

const serviceId = 'hivemind-svc';

type StoredActor = { kind: 'session' | 'person' | 'service'; id: string };

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
  }
): Promise<{ group: Group; root: Task }> {
  return deps.store.transact(async tx => {
    const person = await requireActivePerson(tx, input.workspaceId, input.personId);
    const workspace = await tx.workspace(input.workspaceId);

    if (workspace === null) {
      throw new HivemindError('not_found', 'No workspace with that identifier exists.');
    }

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

    return { group, root };
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
  }
): Promise<{ task: Task }> {
  return deps.store.transact(async tx => {
    const group = await requireGroup(tx, input.workspaceId, input.groupId);
    const root = await requireRoot(tx, input.workspaceId, input.groupId);
    const decision = evaluatePolicy({
      role: 'planner',
      action: 'create_child_task',
      released: !input.actor.live,
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
  }
): Promise<{ task: Task; group: Group }> {
  return deps.store.transact(async tx => {
    const group = await requireGroup(tx, input.workspaceId, input.groupId);
    const task = await requireTask(tx, input.workspaceId, input.taskId, input.groupId);

    if (task.version !== input.expectedVersion) {
      throw new HivemindError('conflict', 'The task changed since it was read.', {
        version: task.version,
        state: task.state,
      });
    }

    const actor = await resolveActor(tx, input.workspaceId, group, input.actor);
    const applied = await applyReport(deps, tx, group, task, actor.transition, actor.stored, {
      to: input.to,
      note: input.note,
      evidence: input.evidence,
      nextVerificationMode: input.nextVerificationMode,
    });

    const childClosed = task.parent_id !== null && isClosedState(applied.task.state);
    const rootEnteredImplementing =
      task.parent_id === null && applied.task.state === 'implementing';

    if (childClosed || rootEnteredImplementing) {
      const closed = await closeRootWhenChildrenDone(deps, tx, applied.group);

      if (rootEnteredImplementing) return closed;

      return { task: applied.task, group: closed.group };
    }

    return applied;
  });
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
    // Sessions are not stored yet, so no implementer has been started through this service.
    implementerEverStarted: false,
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
    implementerEverStarted: false,
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
): Promise<{ transition: TransitionActor; stored: StoredActor }> {
  if (actor.kind === 'service') {
    return { transition: { kind: 'service' }, stored: { kind: 'service', id: serviceId } };
  }

  if (actor.kind === 'session') {
    return {
      transition: { kind: 'session', role: actor.role, live: actor.live },
      stored: { kind: 'session', id: actor.sessionId },
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
  };
}

async function appendEvent(
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

function requireTitle(title: string): string {
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
