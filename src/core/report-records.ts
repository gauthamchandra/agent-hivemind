import { applyReport, closeRootWhenChildrenDone } from '@/core/apply-report.ts';
import type { ReportActor, ServiceDeps } from '@/core/deps.ts';
import {
  type IdempotencyInput,
  lockedCaller,
  rememberIdempotency,
  replayedRecord,
  requireActivePerson,
  requireGroup,
  requireRoot,
  requireTask,
  type StoredActor,
  serviceId,
} from '@/core/record-checks.ts';
import { storedTransition } from '@/core/stored-response.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type {
  EvidenceEntry,
  Group,
  SessionRecord,
  Task,
  TaskState,
  VerificationMode,
} from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { TransitionActor } from '@/domain/transitions.ts';
import { requireAllowed } from '@/policy/policy.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

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
    idempotency?: IdempotencyInput;
  }
): Promise<{ task: Task; group: Group }> {
  return deps.store.transact(async tx => {
    const group = await requireGroup(tx, input.workspaceId, input.groupId);
    const root = await requireRoot(tx, input.workspaceId, input.groupId);
    const task = await requireTask(tx, input.workspaceId, input.taskId, input.groupId);
    const existing = await replayedRecord(tx, input.workspaceId, input.idempotency);

    if (existing) return storedTransition(existing.response) ?? { task, group };

    if (task.version !== input.expectedVersion) {
      throw new HivemindError('conflict', 'The task changed since it was read.', {
        version: task.version,
        state: task.state,
      });
    }

    // Failing the root also fails its open children. Lock them here so they come before the
    // caller's session, which resolveActor locks next.
    if (task.parent_id === null && input.to === 'failed') {
      await tx.openChildren(input.workspaceId, input.groupId, task.id);
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

    if (input.idempotency) {
      await rememberIdempotency(
        tx,
        input.workspaceId,
        input.idempotency,
        result.task.id,
        formatTime(deps.clock.now()),
        { task: result.task, group: result.group }
      );
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
      if (actor.role === undefined || actor.live === undefined) {
        throw new HivemindError('unauthenticated', 'The session token is not valid.');
      }

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
  requireAllowed({
    ...input,
    action: to === 'failed' ? 'fail_task' : 'report_transition',
  });

  if (nextVerificationMode === null || nextVerificationMode === task.verification_mode) return;

  requireAllowed({ ...input, action: 'move_verification_mode' });
}
