import type { ServiceDeps } from '@/core/deps.ts';
import { appendEvent, requireRoot, type StoredActor, serviceId } from '@/core/record-checks.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { EvidenceEntry, Group, Task, TaskState, VerificationMode } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { TransitionActor } from '@/domain/transitions.ts';
import { decideTransition } from '@/domain/transitions.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function applyReport(
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

  await failOpenChildren(deps, tx, task, decision, stored, now);

  return { task: updated, group: current };
}

export async function closeRootWhenChildrenDone(
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

async function failOpenChildren(
  deps: ServiceDeps,
  tx: UnitOfWork,
  task: Task,
  decision: { to: TaskState },
  stored: StoredActor,
  now: string
): Promise<void> {
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
}
