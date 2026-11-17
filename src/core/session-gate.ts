import { reach, rootTask } from '@/core/session-rows.ts';
import type { StartInput } from '@/core/session-types.ts';
import { startRoute } from '@/core/session-types.ts';
import { compareDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import { requireSessionId } from '@/domain/ids.ts';
import type { Group, SessionRecord, SessionRole, Task, Workspace } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { evaluatePolicy } from '@/policy/policy.ts';
import type { Occupancy, UnitOfWork } from '@/ports/storage.ts';

export async function requireStarter(
  tx: UnitOfWork,
  input: StartInput,
  group: Group,
  task: Task,
  root: Task
): Promise<{ parentId: SessionId | null }> {
  if (input.actor.kind === 'person') {
    if (input.role !== 'planner' || task.parent_id !== null) {
      throw new HivemindError('forbidden', 'A person can start a planner on the root task.');
    }

    const person = await tx.person(input.workspaceId, input.actor.personId);

    if (person === null || person.status !== 'active') {
      throw new HivemindError('forbidden', 'That person cannot start a session.');
    }

    if (person.id !== group.owner_person_id && person.workspace_role !== 'administrator') {
      throw new HivemindError(
        'forbidden',
        'Only the owner or an administrator can start a planner.'
      );
    }

    return { parentId: null };
  }

  const caller = await tx.lockSession(input.workspaceId, input.actor.sessionId);

  if (caller === null || caller.token_hash === null) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  if (caller.group_id !== group.id) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  if (caller.life === 'released' || caller.life === 'ended' || caller.life === 'start_failed') {
    throw new HivemindError(
      'session_not_active',
      'The session cannot start a member from this life.',
      {
        life: caller.life,
      }
    );
  }

  if (caller.end_requested_at !== null) {
    throw new HivemindError(
      'session_not_active',
      'The session is ending and cannot start new work.',
      { life: caller.life }
    );
  }

  const decision = evaluatePolicy({
    role: caller.role,
    action: input.replacementOf === null ? 'start_member' : 'start_replacement',
    released: false,
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: caller.task_id === task.id ? 'own' : 'other',
    rootState: root.state,
    targetRole: input.role,
    targetStartedByCaller: false,
    targetTaskClosed: isClosedState(task.state),
  });

  if (!decision.allowed) {
    throw new HivemindError('policy_denied', decision.message, {
      role: decision.role,
      action: decision.action,
    });
  }

  return { parentId: caller.id };
}

export async function requireReplaced(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  taskId: TaskId,
  role: SessionRole
): Promise<void> {
  const previous = await tx.lockSession(workspaceId, sessionId);

  if (previous === null || previous.task_id !== taskId || previous.role !== role) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  const dead =
    previous.life === 'ended' ||
    previous.life === 'start_failed' ||
    previous.last_status === 'stopped' ||
    previous.last_status === 'failed' ||
    previous.last_status === 'unknown';

  if (!dead) {
    throw new HivemindError('conflict', 'That session still holds the role.');
  }
}

export function refuseStartCaps(
  group: Group,
  workspaceLiveLimit: number,
  occupancy: Occupancy,
  spawn: number,
  attempt: number,
  replacements: number,
  onTask: number,
  role: SessionRole
): void {
  if (compareDecimal(group.spend, group.budget) >= 0) {
    reach('budget', group.budget, group.spend);
  }

  if (spawn + 1 > group.caps.spawn_rate) reach('spawn_rate', group.caps.spawn_rate, spawn);
  if (occupancy.total_sessions + 1 > group.caps.total_sessions) {
    reach('total_sessions', group.caps.total_sessions, occupancy.total_sessions);
  }

  if (attempt > 1 && replacements >= group.caps.respawns_per_task_role) {
    reach('respawns_per_task_role', group.caps.respawns_per_task_role, replacements);
  }

  if (occupancy.live_sessions + 1 > group.caps.live_sessions) {
    reach('live_sessions', group.caps.live_sessions, occupancy.live_sessions);
  }

  if (role === 'planner' || role === 'challenger' || role === 'implementer') {
    const current =
      occupancy[
        role === 'planner' ? 'planner' : role === 'challenger' ? 'challenger' : 'implementer'
      ];
    const limit = group.caps.live_per_role[role];

    if (current + 1 > limit) reach('live_per_role', limit, current);
  } else {
    const limit = group.caps.live_per_task_role[role];

    if (onTask + 1 > limit) reach('live_per_task_role', limit, onTask);
  }

  if (occupancy.workspace_live_sessions + 1 > workspaceLiveLimit) {
    reach('workspace_live_sessions', workspaceLiveLimit, occupancy.workspace_live_sessions);
  }
}

export async function lockStart(
  tx: UnitOfWork,
  input: StartInput,
  caller: { kind: 'person' | 'session'; id: string }
): Promise<
  | { replay: true; session: SessionRecord }
  | { replay: false; workspace: Workspace; group: Group; task: Task; root: Task }
> {
  const workspace = await tx.lockWorkspace(input.workspaceId);
  const group = await tx.lockGroup(input.workspaceId, input.groupId);
  const existing = await tx.findIdempotency(
    input.workspaceId,
    caller.kind,
    caller.id,
    startRoute(input.replacementOf),
    input.idempotencyKey
  );

  if (existing) {
    if (existing.body_hash !== input.bodyHash) {
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

    const replay = await tx.lockSession(input.workspaceId, requireSessionId(existing.record_id));

    if (replay === null) {
      throw new HivemindError(
        'request_in_progress',
        'The first request with this key is not complete.'
      );
    }

    return { replay: true, session: replay };
  }

  if (workspace === null || group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  if (group.status !== 'open') {
    throw new HivemindError('group_closed', 'The group accepts no new work.');
  }

  const root = await rootTask(tx, input.workspaceId, group.id);
  const task = await tx.lockTask(input.workspaceId, input.taskId);

  if (task === null || task.group_id !== group.id) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  if (isClosedState(task.state)) {
    throw new HivemindError('conflict', 'The task is closed.');
  }
  return { replay: false, workspace, group, task, root };
}
