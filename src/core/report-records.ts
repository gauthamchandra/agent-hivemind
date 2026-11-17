import { applyReport, closeRootWhenChildrenDone } from '@/core/apply-report.ts';
import type { ReportActor, ServiceDeps } from '@/core/deps.ts';
import {
  requireActivePerson,
  requireGroup,
  requireRoot,
  requireTask,
  type StoredActor,
  serviceId,
} from '@/core/record-checks.ts';
import { storedTransition } from '@/core/stored-response.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
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
import { evaluatePolicy } from '@/policy/policy.ts';
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

export async function lockedCaller(tx: UnitOfWork, workspaceId: WorkspaceId, sessionId: SessionId) {
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
