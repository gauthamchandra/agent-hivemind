import type { ServiceDeps } from '@/core/deps.ts';
import { appendEvent, requireTitle } from '@/core/record-checks.ts';
import { requireLiveCaller, requireText, rootTask } from '@/core/session-rows.ts';
import { storedTask } from '@/core/stored-response.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import { requireTaskId } from '@/domain/ids.ts';
import type { EvidenceEntry, SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import { evaluatePolicy } from '@/policy/policy.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function noteActivity(
  deps: ServiceDeps,
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  report: boolean
): Promise<SessionRecord> {
  return deps.store.transact(async tx => {
    const session = await tx.lockSession(workspaceId, sessionId);

    if (session === null) {
      throw new HivemindError('unauthenticated', 'The session token is not valid.');
    }

    const now = formatTime(deps.clock.now());

    if (session.enrolled_at === null) {
      session.enrolled_at = now;
      session.enrolled_by = session.enrolled_by ?? 'secret';
    }

    if (session.life === 'starting' && session.existence_evidence_at === null) {
      session.existence_evidence_at = now;
    }

    if (report) session.last_report_at = now;

    await tx.updateSession(session);

    return session;
  });
}

export async function editChildTask(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    taskId: TaskId;
    title: string | null;
    description: string | null;
  }
): Promise<Task> {
  return deps.store.transact(async tx => {
    const caller = await tx.sessionById(input.sessionId);

    if (caller === null || caller.workspace_id !== input.workspaceId) {
      throw new HivemindError('unauthenticated', 'The session token is not valid.');
    }

    const root = await rootTask(tx, input.workspaceId, caller.group_id);
    const task = await tx.lockTask(input.workspaceId, input.taskId);

    if (task === null) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

    const session = await requireLiveCaller(tx, input.workspaceId, input.sessionId);

    if (task.group_id !== session.group_id) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

    const decision = evaluatePolicy({
      role: session.role,
      action: 'edit_child_task',
      released: session.life === 'released',
      taskKind: task.parent_id === null ? 'root' : 'child',
      taskState: task.state,
      relation: 'own',
      rootState: root.state,
      targetRole: session.role,
      targetStartedByCaller: false,
      targetTaskClosed: isClosedState(task.state),
    });

    if (!decision.allowed) {
      throw new HivemindError('policy_denied', decision.message, {
        role: decision.role,
        action: decision.action,
      });
    }

    if (input.title !== null) task.title = requireTitle(input.title);
    if (input.description !== null) {
      task.description = requireText(input.description, 'description', 32 * 1024);
    }

    await tx.updateTask(task);
    await tx.touchReport(session.id, formatTime(deps.clock.now()));

    return task;
  });
}

export async function addTaskNote(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    taskId: TaskId;
    note: string;
    evidence: EvidenceEntry[];
    idempotency?: {
      key: string;
      bodyHash: string;
      callerKind: string;
      callerId: string;
      route: string;
    };
  }
): Promise<Task> {
  return deps.store.transact(tx => writeTaskNote(deps, tx, input));
}

async function replayedNote(
  tx: UnitOfWork,
  input: Parameters<typeof addTaskNote>[1],
  task: Task
): Promise<Task | null> {
  if (input.idempotency) {
    const existing = await tx.findIdempotency(
      input.workspaceId,
      input.idempotency.callerKind,
      input.idempotency.callerId,
      input.idempotency.route,
      input.idempotency.key
    );

    if (existing) {
      if (existing.body_hash !== input.idempotency.bodyHash) {
        throw new HivemindError(
          'idempotency_conflict',
          'That idempotency key was used with a different body.'
        );
      }

      const noted = storedTask(existing.response);

      if (noted) return noted;

      if (existing.record_id === null || existing.record_id === task.id) {
        if (existing.record_id === null) {
          throw new HivemindError(
            'request_in_progress',
            'The first request with this key is not complete.'
          );
        }

        return task;
      }

      const saved = await tx.lockTask(input.workspaceId, requireTaskId(existing.record_id));

      if (saved === null) {
        throw new HivemindError(
          'request_in_progress',
          'The first request with this key is not complete.'
        );
      }

      return saved;
    }
  }
  return null;
}

async function writeTaskNote(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: Parameters<typeof addTaskNote>[1]
): Promise<Task> {
  const caller = await tx.sessionById(input.sessionId);

  if (caller === null || caller.workspace_id !== input.workspaceId) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  const group = await tx.lockGroup(input.workspaceId, caller.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const root = await rootTask(tx, input.workspaceId, group.id);
  const task = await tx.lockTask(input.workspaceId, input.taskId);

  if (task === null) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  const replayed = await replayedNote(tx, input, task);

  if (replayed) return replayed;

  const session = await requireLiveCaller(tx, input.workspaceId, input.sessionId);

  if (task.group_id !== session.group_id) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  const decision = evaluatePolicy({
    role: session.role,
    action: 'add_note',
    released: session.life === 'released',
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: session.task_id === task.id ? 'own' : 'other',
    rootState: root.state,
    targetRole: session.role,
    targetStartedByCaller: false,
    targetTaskClosed: isClosedState(task.state),
  });

  if (!decision.allowed) {
    throw new HivemindError('policy_denied', decision.message, {
      role: decision.role,
      action: decision.action,
    });
  }

  const note = requireText(input.note, 'note', 4 * 1024);

  await appendEvent(deps, tx, {
    workspace_id: task.workspace_id,
    task_id: task.id,
    group_id: task.group_id,
    kind: 'note',
    actor: { kind: 'session', id: session.id },
    from_state: task.state,
    to_state: task.state,
    evidence: input.evidence,
    note,
    data: {},
  });
  const notedAt = formatTime(deps.clock.now());

  await tx.touchReport(session.id, notedAt);

  if (input.idempotency) {
    await tx.insertIdempotency({
      workspaceId: input.workspaceId,
      callerKind: input.idempotency.callerKind,
      callerId: input.idempotency.callerId,
      route: input.idempotency.route,
      key: input.idempotency.key,
      bodyHash: input.idempotency.bodyHash,
      recordId: task.id,
      completed: true,
      response: { task },
      at: notedAt,
    });
  }

  return task;
}
