import type { ServiceDeps } from '@/core/deps.ts';
import {
  appendEvent,
  type IdempotencyInput,
  rememberIdempotency,
  replayedGroup,
  requireActivePerson,
  requireBoundedText,
  requireGroup,
  requireGroupName,
  requireRoot,
} from '@/core/record-checks.ts';
import { requireContextNotes } from '@/domain/context.ts';
import { compareDecimal, requirePositiveDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { ConnectionId, GroupId, PersonId, WorkspaceId } from '@/domain/ids.ts';
import type { Group, Task, VerificationMode } from '@/domain/model.ts';
import { emptySessionSettings } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';

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
