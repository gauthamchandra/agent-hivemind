import type { ServiceDeps } from '@/core/deps.ts';
import {
  appendEvent,
  type IdempotencyInput,
  rememberIdempotency,
  replayedTask,
  requireBoundedText,
  requireGroup,
  requireRoot,
  requireTitle,
} from '@/core/record-checks.ts';
import { lockedCaller } from '@/core/report-records.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type { Task, VerificationMode } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import { evaluatePolicy } from '@/policy/policy.ts';

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
