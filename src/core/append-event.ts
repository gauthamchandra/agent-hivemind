import type { ServiceDeps } from '@/core/deps.ts';
import type { StoredActor } from '@/core/record-checks.ts';
import type { GroupId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type { EvidenceEntry, TaskEvent, TaskState } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

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
