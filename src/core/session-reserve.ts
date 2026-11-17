import { appendEvent } from '@/core/append-event.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { composePrompt } from '@/core/prompt.ts';
import { requireBoundedText } from '@/core/record-checks.ts';
import { occupancyFor } from '@/core/session-caps.ts';
import {
  lockStart,
  refuseStartCaps,
  requireReplaced,
  requireStarter,
} from '@/core/session-gate.ts';
import { callerOf, randomText, roleLabel } from '@/core/session-lock.ts';
import {
  enrollmentTtlMs,
  type Reserved,
  type StartInput,
  spawnWindowMs,
  startRoute,
} from '@/core/session-types.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId } from '@/domain/ids.ts';
import type { Group, SessionRecord, Task } from '@/domain/model.ts';
import type { Capability } from '@/domain/platform.ts';
import { enrollmentCodeSecret, sessionTokenSecret, sha256Hex } from '@/domain/secret.ts';
import { formatTime, parseTime } from '@/domain/time.ts';
import type { Platforms, StartSessionInput } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export async function reserveStart(
  deps: ServiceDeps,
  platforms: Platforms,
  tx: UnitOfWork,
  input: StartInput
): Promise<Reserved> {
  const instructions = requireBoundedText(input.instructions, 'instructions', 16 * 1024);
  const caller = callerOf(input);
  const locked = await lockStart(tx, input, caller);

  if (locked.replay) return { replay: true, session: locked.session };

  const { workspace, group, task } = locked;
  const parent = await requireStarter(tx, input, group, task, locked.root);
  const capabilities = new Set(platforms.require(group.connection_id).connection.capabilities);

  if (input.replacementOf !== null) {
    await requireReplaced(tx, input.workspaceId, input.replacementOf, task.id, input.role);
  }

  if (input.role !== 'challenger' && (await tx.holderCount(task.id, input.role)) > 0) {
    throw new HivemindError('conflict', 'This role on this task already has a session.');
  }

  const counts = await startCounts(deps, tx, input, group.id, task.id);

  refuseStartCaps(
    group,
    workspace.limits.live_sessions,
    counts.occupancy,
    counts.spawn,
    counts.attempt,
    counts.replacements,
    counts.onTask,
    input.role
  );

  if (input.role === 'implementer' && task.changeset_id === null) {
    task.changeset_id = deps.ids.changeset();
    await tx.updateTask(task);
  }

  return insertStartingSession(
    deps,
    tx,
    input,
    caller,
    instructions,
    group,
    task,
    parent.parentId,
    capabilities,
    counts.attempt
  );
}

async function startCounts(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: StartInput,
  groupId: Group['id'],
  taskId: Task['id']
) {
  const occupancy = await tx.occupancy(input.workspaceId, groupId);
  const since = formatTime(new Date(deps.clock.now().getTime() - spawnWindowMs));
  const spawn = await tx.spawnCount(groupId, since);
  const attempt =
    input.role === 'challenger' && input.replacementOf === null
      ? 1
      : await tx.nextAttempt(taskId, input.role);
  const replacements = await tx.replacementCount(taskId, input.role);
  const onTask = await tx.liveOnTask(taskId, input.role);
  return { occupancy, spawn, attempt, replacements, onTask };
}

async function insertStartingSession(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: StartInput,
  caller: { kind: 'person' | 'session'; id: string },
  instructions: string,
  group: Group,
  task: Task,
  parentId: SessionId | null,
  capabilities: ReadonlySet<Capability>,
  attempt: number
): Promise<Reserved> {
  const now = formatTime(deps.clock.now());
  const token = capabilities.has('secret_injection') ? sessionTokenSecret(deps.random) : null;
  const code = token === null ? enrollmentCodeSecret(deps.random) : null;
  const session: SessionRecord = {
    id: deps.ids.session(),
    workspace_id: input.workspaceId,
    group_id: group.id,
    task_id: task.id,
    role: input.role,
    attempt,
    parent_session_id: parentId,
    platform_session_ref: null,
    platform_address: null,
    title: `${group.name} - ${roleLabel(input.role)} ${attempt}`,
    life: 'starting',
    token_hash: token === null ? null : sha256Hex(token),
    enrolled_at: null,
    enrolled_by: null,
    last_report_at: null,
    start_attempt_id: randomText(deps),
    existence_evidence_at: null,
    end_requested_at: null,
    end_actor_kind: null,
    end_actor_id: null,
    end_reason: null,
    end_operation_id: null,
    final_usage_pending: false,
    last_status: null,
    usage: null,
    attributed_to: null,
    secret_delivered: null,
    created_at: now,
    ended_at: null,
  };

  await tx.insertSession(session);
  await tx.insertSpawn({
    id: randomText(deps),
    workspaceId: input.workspaceId,
    groupId: group.id,
    sessionId: session.id,
    at: now,
  });
  await tx.addOccupancy(input.workspaceId, group.id, occupancyFor(input.role, 1, 1));
  await tx.insertIdempotency({
    workspaceId: input.workspaceId,
    callerKind: caller.kind,
    callerId: caller.id,
    route: startRoute(input.replacementOf),
    key: input.idempotencyKey,
    bodyHash: input.bodyHash,
    recordId: session.id,
    completed: true,
    at: now,
  });

  if (code !== null) {
    await tx.insertEnrollmentCode({
      id: randomText(deps),
      workspace_id: input.workspaceId,
      session_id: session.id,
      code_hash: sha256Hex(code),
      expires_at: formatTime(new Date(parseTime(now).getTime() + enrollmentTtlMs)),
      used_at: null,
      attempts: 0,
      voided_at: null,
      created_at: now,
    });
  }

  if (parentId !== null) await tx.touchReport(parentId, now);

  await appendEvent(deps, tx, {
    workspace_id: input.workspaceId,
    task_id: task.id,
    group_id: group.id,
    kind: 'session_started',
    actor: caller,
    from_state: null,
    to_state: null,
    evidence: [],
    note: null,
    data: { session_id: session.id, role: session.role, attempt: session.attempt },
  });

  return {
    replay: false,
    session,
    startAttemptId: session.start_attempt_id,
    connectionId: group.connection_id,
    platformInput: startingPlatformInput(
      input,
      instructions,
      group,
      task,
      parentId,
      session,
      token,
      code,
      attempt
    ),
  };
}

function startingPlatformInput(
  input: StartInput,
  instructions: string,
  group: Group,
  task: Task,
  parentId: SessionId | null,
  session: SessionRecord,
  token: string | null,
  code: string | null,
  attempt: number
): StartSessionInput {
  return {
    prompt: composePrompt({
      role: input.role,
      sessionId: session.id,
      group,
      task,
      parentSessionId: parentId,
      instructions,
      enrollmentCode: code,
      replacement: attempt > 1,
    }),
    title: session.title,
    idempotencyKey: session.id,
    settings: group.session_settings,
    secret: token === null ? null : { name: 'HIVEMIND_TOKEN', value: token },
    onBehalfOf: null,
    usageCeiling: null,
    tags: {
      workspaceId: input.workspaceId,
      groupId: group.id,
      sessionId: session.id,
      role: input.role,
    },
  };
}
