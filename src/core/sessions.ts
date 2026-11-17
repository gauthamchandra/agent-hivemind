import type { ServiceDeps } from '@/core/deps.ts';
import { composePrompt } from '@/core/prompt.ts';
import { appendEvent, createGroup, reportTransition, requireTitle } from '@/core/records.ts';
import {
  addDecimal,
  canonicalizeDecimal,
  compareDecimal,
  decimalFromNumber,
  subtractDecimal,
} from '@/domain/decimal.ts';
import { type ErrorCode, errorCodes, HivemindError } from '@/domain/errors.ts';
import type { GroupId, PersonId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import { requireSessionId, requireTaskId } from '@/domain/ids.ts';
import type {
  EvidenceEntry,
  Group,
  SessionRecord,
  SessionRole,
  Task,
  VerificationMode,
} from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { isRefusal, PlatformError, type PlatformErrorClass } from '@/domain/platform.ts';
import {
  enrollmentCodeSecret,
  openText,
  sealText,
  sessionTokenSecret,
  sha256Hex,
} from '@/domain/secret.ts';
import { formatTime, parseTime } from '@/domain/time.ts';
import { evaluatePolicy } from '@/policy/policy.ts';
import type { Platforms, StartSessionInput, StartSessionResult } from '@/ports/platform.ts';
import type { Occupancy, OccupancyDelta, UnitOfWork } from '@/ports/storage.ts';

const routeStart = 'session.start';
const openFailureRoute = 'group.open.failure';

function startRoute(replacementOf: SessionId | null): string {
  return replacementOf === null ? routeStart : `session.replace:${replacementOf}`;
}
const routeEnroll = 'session.enroll';
const enrollmentTtlMs = 15 * 60 * 1000;
const spawnWindowMs = 60 * 60 * 1000;

export type CrashPoint =
  | 'after_reserve'
  | 'after_platform_accept'
  | 'after_end_intent'
  | 'after_platform_end';

/** The process stopped after a committed step. Recovery continues from the row. */
export class StoppedProcess extends Error {
  readonly point: CrashPoint;

  constructor(point: CrashPoint) {
    super(`The process stopped at ${point}.`);
    this.name = 'StoppedProcess';
    this.point = point;
  }
}

export type StartOutcome = {
  outcome: 'live' | 'released' | 'ended' | 'start_pending' | 'refused';
  session: SessionRecord;
  errorClass?: PlatformErrorClass;
};

type StartInput = {
  workspaceId: WorkspaceId;
  groupId: GroupId;
  taskId: TaskId;
  role: SessionRole;
  instructions: string;
  actor: { kind: 'person'; personId: PersonId } | { kind: 'session'; sessionId: SessionId };
  idempotencyKey: string;
  bodyHash: string;
  replacementOf: SessionId | null;
  crashAt?: CrashPoint;
};

type Reserved =
  | { replay: true; session: SessionRecord }
  | {
      replay: false;
      session: SessionRecord;
      startAttemptId: string;
      connectionId: Group['connection_id'];
      platformInput: StartSessionInput;
    };

/**
 * Record a session and take its places, then ask the platform to start.
 * A crash after the record is recovered with find-by-key. A crash after the
 * platform accepts is completed without a second start call.
 */
export async function startSession(
  deps: ServiceDeps,
  platforms: Platforms,
  input: StartInput
): Promise<StartOutcome> {
  const reserved = await deps.store.transact(tx => reserveStart(deps, platforms, tx, input));

  if (reserved.replay) return storedOutcome(deps, reserved.session);

  if (input.crashAt === 'after_reserve') throw new StoppedProcess('after_reserve');

  const handle = platforms.require(reserved.connectionId);

  try {
    const started = await handle.adapter.start(handle.connection, reserved.platformInput);

    if (input.crashAt === 'after_platform_accept')
      throw new StoppedProcess('after_platform_accept');

    const session = await deps.store.transact(tx =>
      completeStart(deps, tx, reserved.session, reserved.startAttemptId, started)
    );

    if (session.end_requested_at !== null && session.life !== 'ended') {
      return outcomeFrom(await finishPlatformEnd(deps, platforms, session, undefined));
    }

    if (session.life === 'ended') {
      return outcomeFrom(await settleEndedPlatform(deps, platforms, session));
    }

    if (session.life !== 'live') {
      if (
        session.life === 'start_failed' &&
        session.final_usage_pending &&
        session.platform_session_ref !== null
      ) {
        await stopCompensatedPlatform(deps, platforms, session);
      }

      return outcomeFrom((await deps.store.session(session.workspace_id, session.id)) ?? session);
    }

    return { outcome: 'live', session };
  } catch (error) {
    if (error instanceof StoppedProcess) throw error;

    if (error instanceof PlatformError && error.errorClass === 'unavailable') {
      const session =
        (await deps.store.session(input.workspaceId, reserved.session.id)) ?? reserved.session;

      if (session.life !== 'starting' || session.end_requested_at !== null) {
        if (session.end_requested_at !== null && session.life !== 'ended') {
          return outcomeFrom(await finishPlatformEnd(deps, platforms, session, undefined));
        }

        return outcomeFrom(session);
      }

      return { outcome: 'start_pending', session };
    }

    if (error instanceof PlatformError && isRefusal(error.errorClass)) {
      const current =
        (await deps.store.session(input.workspaceId, reserved.session.id)) ?? reserved.session;

      if (current.end_requested_at !== null || current.platform_session_ref !== null) {
        throw new HivemindError('unavailable', 'The platform did not stop the session.');
      }

      const session = await deps.store.transact(tx =>
        compensateStart(deps, tx, reserved.session, error.errorClass)
      );

      return { outcome: 'refused', session, errorClass: error.errorClass };
    }

    throw error;
  }
}

export async function openGroup(
  deps: ServiceDeps,
  platforms: Platforms,
  input: {
    workspaceId: WorkspaceId;
    personId: PersonId;
    name: string;
    goal: string;
    budget: string;
    connectionId: Group['connection_id'];
    verificationMode: VerificationMode | null;
    notes: { name: string; body: string }[];
    instructions: string;
    idempotencyKey: string;
    bodyHash: string;
  }
): Promise<{
  outcome: StartOutcome['outcome'];
  group: Group;
  root: Task;
  session: SessionRecord;
  errorClass?: PlatformErrorClass;
}> {
  requireText(input.instructions, 'instructions', 16 * 1024);

  const handle = platforms.require(input.connectionId);

  if (!handle.connection.capabilities.includes('usage_reading')) {
    throw new HivemindError('capability_missing', 'The connection does not report usage.', {
      capability: 'usage_reading',
    });
  }

  const created = await createGroup(deps, {
    workspaceId: input.workspaceId,
    personId: input.personId,
    name: input.name,
    goal: input.goal,
    budget: input.budget,
    connectionId: input.connectionId,
    verificationMode: input.verificationMode,
    notes: input.notes,
    idempotency: {
      key: input.idempotencyKey,
      bodyHash: input.bodyHash,
      callerKind: 'person',
      callerId: input.personId,
      route: 'group.open',
    },
  });

  if (created.replay) {
    const sessions = await deps.store.sessions(input.workspaceId, created.group.id);
    const planner = sessions.find(session => session.role === 'planner');

    if (planner) {
      if (planner.life === 'start_failed') {
        await closeGroupWithoutPlanner(deps, input, created.group);
      }

      const outcome = await storedOutcome(deps, planner);
      const group = (await deps.store.group(input.workspaceId, created.group.id)) ?? created.group;
      const tasks = await deps.store.tasks(input.workspaceId, created.group.id);
      const root = tasks.find(task => task.parent_id === null) ?? created.root;

      return { ...outcome, group, root };
    }

    const remembered = await rememberedOpenFailure(deps, input);

    if (remembered) throw remembered;
  }

  let started: Awaited<ReturnType<typeof startSession>>;

  try {
    started = await startSession(deps, platforms, {
      workspaceId: input.workspaceId,
      groupId: created.group.id,
      taskId: created.root.id,
      role: 'planner',
      instructions: input.instructions,
      actor: { kind: 'person', personId: input.personId },
      idempotencyKey: `${input.idempotencyKey}:planner`,
      bodyHash: input.bodyHash,
      replacementOf: null,
    });
  } catch (error) {
    await closeGroupWithoutPlanner(deps, input, created.group);

    const named =
      error instanceof HivemindError
        ? new HivemindError(error.code, `${error.message} Group ${created.group.id} was closed.`, {
            ...error.details,
            group_id: created.group.id,
          })
        : error;

    await rememberOpenFailure(deps, input, created.group.id, named);

    throw named;
  }

  if (started.outcome !== 'refused') {
    return {
      outcome: started.outcome,
      group: created.group,
      root: created.root,
      session: started.session,
    };
  }

  const failed = await reportTransition(deps, {
    workspaceId: input.workspaceId,
    groupId: created.group.id,
    taskId: created.root.id,
    expectedVersion: created.root.version,
    actor: { kind: 'person', personId: input.personId },
    to: 'failed',
    note: 'The platform refused to start the planner.',
    evidence: [],
    nextVerificationMode: null,
  });

  return {
    outcome: 'refused',
    group: failed.group,
    root: failed.task,
    session: started.session,
    errorClass: started.errorClass ?? 'invalid',
  };
}

async function closeGroupWithoutPlanner(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; personId: PersonId },
  group: Group
): Promise<void> {
  const sessions = await deps.store.sessions(input.workspaceId, group.id);

  if (sessions.some(session => session.role === 'planner' && session.life !== 'start_failed')) {
    return;
  }

  const current = await deps.store.group(input.workspaceId, group.id);
  const tasks = await deps.store.tasks(input.workspaceId, group.id);
  const liveRoot = tasks.find(task => task.parent_id === null);

  if (
    current === null ||
    current.status !== 'open' ||
    liveRoot === undefined ||
    isClosedState(liveRoot.state)
  ) {
    return;
  }

  await reportTransition(deps, {
    workspaceId: input.workspaceId,
    groupId: group.id,
    taskId: liveRoot.id,
    expectedVersion: liveRoot.version,
    actor: { kind: 'person', personId: input.personId },
    to: 'failed',
    note: 'The planner did not start.',
    evidence: [],
    nextVerificationMode: null,
  });
}

async function rememberedOpenFailure(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; personId: PersonId; idempotencyKey: string }
): Promise<HivemindError | null> {
  const row = await deps.store.transact(tx =>
    tx.findIdempotency(
      input.workspaceId,
      'person',
      input.personId,
      openFailureRoute,
      input.idempotencyKey
    )
  );

  return failureFrom(row?.response);
}

async function rememberOpenFailure(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    personId: PersonId;
    idempotencyKey: string;
    bodyHash: string;
  },
  groupId: GroupId,
  error: unknown
): Promise<void> {
  if (!(error instanceof HivemindError)) return;

  await deps.store.transact(async tx => {
    const existing = await tx.findIdempotency(
      input.workspaceId,
      'person',
      input.personId,
      openFailureRoute,
      input.idempotencyKey
    );

    if (existing) return;

    await tx.insertIdempotency({
      workspaceId: input.workspaceId,
      callerKind: 'person',
      callerId: input.personId,
      route: openFailureRoute,
      key: input.idempotencyKey,
      bodyHash: input.bodyHash,
      recordId: groupId,
      response: { code: error.code, message: error.message, details: error.details },
      completed: true,
      at: formatTime(deps.clock.now()),
    });
  });
}

function failureFrom(response: unknown): HivemindError | null {
  if (typeof response !== 'object' || response === null) return null;

  const code = Reflect.get(response, 'code');
  const message = Reflect.get(response, 'message');
  const details = Reflect.get(response, 'details');

  if (typeof code !== 'string' || !(errorCodes as readonly string[]).includes(code)) return null;
  if (typeof message !== 'string') return null;
  if (typeof details !== 'object' || details === null) return null;

  const safe: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' || typeof value === 'number') safe[key] = value;
  }

  return new HivemindError(code as ErrorCode, message, safe);
}

export async function releaseSession(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    idempotency?: { key: string; bodyHash: string };
  }
): Promise<SessionRecord> {
  return deps.store.transact(async tx => {
    const session = await lockOwned(tx, input.workspaceId, input.sessionId);

    const released = await replayedLife(tx, session, 'session.release', input.idempotency);

    if (released) return released;

    if (session.life === 'starting') {
      throw new HivemindError('conflict', 'A session cannot release until its start completes.');
    }

    if (session.life !== 'live') {
      throw new HivemindError('session_not_active', 'The session cannot release from this life.', {
        life: session.life,
      });
    }

    const now = formatTime(deps.clock.now());

    await tx.addOccupancy(
      session.workspace_id,
      session.group_id,
      occupancyFor(session.role, -1, 0)
    );
    session.life = 'released';
    session.last_report_at = now;
    await tx.updateSession(session);
    await rememberLife(tx, session, 'session.release', input.idempotency, now);

    return session;
  });
}

export async function resumeSession(
  deps: ServiceDeps,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    idempotency?: { key: string; bodyHash: string };
  }
): Promise<SessionRecord> {
  return deps.store.transact(async tx => {
    const session = await lockOwned(tx, input.workspaceId, input.sessionId);

    const resumed = await replayedLife(tx, session, 'session.resume', input.idempotency);

    if (resumed) return resumed;

    if (session.life !== 'released') {
      throw new HivemindError(
        'session_not_active',
        'Only a released session can become live again.',
        {
          life: session.life,
        }
      );
    }

    if (session.end_requested_at !== null) {
      throw new HivemindError('conflict', 'The session is already ending.');
    }

    const group = await tx.lockGroup(session.workspace_id, session.group_id);
    const workspace = await tx.lockWorkspace(session.workspace_id);

    if (group === null || workspace === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    if (group.status !== 'open') {
      throw new HivemindError('group_closed', 'The group accepts no new work.');
    }

    const occupancy = await tx.occupancy(session.workspace_id, session.group_id);
    const task = await tx.lockTask(session.workspace_id, session.task_id);

    if (task === null) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

    if (isClosedState(task.state)) {
      throw new HivemindError('conflict', 'The task is closed.');
    }

    refuseResumeCaps(
      group,
      workspace.limits.live_sessions,
      occupancy,
      session.role,
      await tx.liveOnTask(task.id, session.role)
    );
    const now = formatTime(deps.clock.now());

    session.life = 'live';
    session.last_report_at = now;
    await tx.addOccupancy(session.workspace_id, session.group_id, occupancyFor(session.role, 1, 0));
    await tx.updateSession(session);
    await rememberLife(tx, session, 'session.resume', input.idempotency, now);

    return session;
  });
}

async function replayedLife(
  tx: UnitOfWork,
  session: SessionRecord,
  route: string,
  idempotency: { key: string; bodyHash: string } | undefined
): Promise<SessionRecord | null> {
  if (idempotency === undefined) return null;

  const existing = await tx.findIdempotency(
    session.workspace_id,
    'session',
    session.id,
    route,
    idempotency.key
  );

  if (existing === null) return null;

  if (existing.body_hash !== idempotency.bodyHash) {
    throw new HivemindError(
      'idempotency_conflict',
      'That idempotency key was used with a different body.'
    );
  }

  return storedSession(existing.response) ?? session;
}

async function rememberLife(
  tx: UnitOfWork,
  session: SessionRecord,
  route: string,
  idempotency: { key: string; bodyHash: string } | undefined,
  at: string
): Promise<void> {
  if (idempotency === undefined) return;

  await tx.insertIdempotency({
    workspaceId: session.workspace_id,
    callerKind: 'session',
    callerId: session.id,
    route,
    key: idempotency.key,
    bodyHash: idempotency.bodyHash,
    recordId: session.id,
    completed: true,
    response: { session: { ...session, token_hash: null } },
    at,
  });
}

function storedSession(response: unknown): SessionRecord | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, 'session');

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const life = Reflect.get(value, 'life');

  if (typeof id !== 'string' || typeof life !== 'string') return null;

  return value as SessionRecord;
}

function storedTask(response: unknown): Task | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, 'task');

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const state = Reflect.get(value, 'state');
  const version = Reflect.get(value, 'version');

  if (typeof id !== 'string' || typeof state !== 'string' || typeof version !== 'number') {
    return null;
  }

  return value as Task;
}

/**
 * Record the ending intent and delete the token before asking the platform to stop.
 * Places stay taken until the platform call finishes, so a crash can resume the end.
 */
export async function endSession(
  deps: ServiceDeps,
  platforms: Platforms,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    actor:
      | { kind: 'session'; sessionId: SessionId }
      | { kind: 'person'; personId: PersonId }
      | { kind: 'service' };
    reason: string;
    crashAt?: CrashPoint;
  }
): Promise<SessionRecord> {
  const prepared = await deps.store.transact(tx => recordEndIntent(deps, tx, input));

  if (prepared.finished) {
    if (prepared.session.life === 'start_failed') {
      return reclaimCompensatedStart(deps, platforms, prepared.session);
    }

    if (!prepared.session.final_usage_pending) return prepared.session;

    return settleEndedPlatform(deps, platforms, prepared.session);
  }

  if (input.crashAt === 'after_end_intent') throw new StoppedProcess('after_end_intent');

  return finishPlatformEnd(deps, platforms, prepared.session, input.crashAt);
}

export async function resumeEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  input: { workspaceId: WorkspaceId; sessionId: SessionId }
): Promise<SessionRecord> {
  const session = await deps.store.session(input.workspaceId, input.sessionId);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (session.life === 'ended') return settleEndedPlatform(deps, platforms, session);

  if (session.end_requested_at === null) {
    throw new HivemindError('conflict', 'The session has no ending intent.');
  }

  return finishPlatformEnd(deps, platforms, session, undefined);
}

export async function recoverStart(
  deps: ServiceDeps,
  platforms: Platforms,
  input: { workspaceId: WorkspaceId; sessionId: SessionId }
): Promise<SessionRecord> {
  const current = await deps.store.session(input.workspaceId, input.sessionId);

  if (current === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (current.life !== 'starting') {
    if (current.life === 'ended') return settleEndedPlatform(deps, platforms, current);

    if (current.life === 'start_failed') {
      return reclaimCompensatedStart(deps, platforms, current);
    }

    return current;
  }

  const group = await deps.store.group(input.workspaceId, current.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);
  let found: Awaited<ReturnType<typeof handle.adapter.findByKey>>;

  try {
    found = await handle.adapter.findByKey(handle.connection, current.id, current.created_at);
  } catch (error) {
    if (error instanceof PlatformError) return current;

    throw error;
  }

  if (found.outcome === 'inconclusive') return current;

  if (found.outcome === 'absent') {
    if (current.end_requested_at !== null) {
      return finishPlatformEnd(deps, platforms, current, undefined);
    }

    if (current.existence_evidence_at !== null) return current;

    return deps.store.transact(tx => compensateStart(deps, tx, current, 'invalid'));
  }

  const completed = await deps.store.transact(tx =>
    completeStart(deps, tx, current, current.start_attempt_id, {
      platformSessionRef: found.platformSessionRef,
      address: found.address,
      attributedTo: 'service',
      secretDelivered: current.token_hash === null ? 'no' : 'yes',
    })
  );

  if (completed.end_requested_at !== null && completed.life !== 'ended') {
    return finishPlatformEnd(deps, platforms, completed, undefined);
  }

  if (completed.life === 'ended') return settleEndedPlatform(deps, platforms, completed);

  if (
    completed.life === 'start_failed' &&
    completed.final_usage_pending &&
    completed.platform_session_ref !== null
  ) {
    return stopCompensatedPlatform(deps, platforms, completed);
  }

  return completed;
}

export async function enroll(
  deps: ServiceDeps,
  input: { sessionId: SessionId; code: string; idempotencyKey: string; bodyHash: string }
): Promise<{ token: string; session: SessionRecord }> {
  const enrolled = await deps.store.transact(async tx => {
    const located = await tx.sessionById(input.sessionId);

    if (located === null) {
      throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
    }

    const locked = await tx.lockSession(located.workspace_id, input.sessionId);

    if (locked === null) {
      throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
    }

    const existing = await tx.findIdempotency(
      located.workspace_id,
      'session',
      input.sessionId,
      routeEnroll,
      input.idempotencyKey
    );

    if (existing) {
      if (existing.body_hash !== input.bodyHash) {
        throw new HivemindError(
          'idempotency_conflict',
          'That idempotency key was used with a different body.'
        );
      }

      const token = await storedToken(deps.responseKey, existing.response);

      if (token === null) {
        throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
      }

      return { token, session: locked };
    }

    const now = formatTime(deps.clock.now());
    const record = await tx.enrollmentByHash(sha256Hex(input.code));

    if (record === null || record.session_id !== input.sessionId) {
      await noteBadCode(tx, input.sessionId, now);

      return null;
    }

    if (
      record.used_at !== null ||
      record.voided_at !== null ||
      codeExpired(deps, record.expires_at)
    ) {
      throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
    }

    if (locked.enrolled_by === 'secret') {
      throw new HivemindError('conflict', 'The session already enrolled with its injected secret.');
    }

    if (deps.responseKey.length === 0) {
      throw new HivemindError('unavailable', 'HIVEMIND_RESPONSE_KEY is not set.');
    }

    const token = sessionTokenSecret(deps.random);

    locked.token_hash = sha256Hex(token);
    locked.enrolled_at = now;
    locked.enrolled_by = 'code';

    if (locked.life === 'starting' && locked.existence_evidence_at === null) {
      locked.existence_evidence_at = now;
    }

    record.used_at = now;
    await tx.saveEnrollmentCode(record);
    await tx.updateSession(locked);
    await tx.insertIdempotency({
      workspaceId: located.workspace_id,
      callerKind: 'session',
      callerId: input.sessionId,
      route: routeEnroll,
      key: input.idempotencyKey,
      bodyHash: input.bodyHash,
      recordId: locked.id,
      response: { sealed: await sealText(deps.responseKey, token, deps.random) },
      completed: true,
      at: now,
    });

    return { token, session: locked };
  });

  if (enrolled === null) {
    throw new HivemindError('unauthenticated', 'The enrollment code is not valid.');
  }

  return enrolled;
}

/** Record enrollment and, while a start is unfinished, existence evidence. A read does not move last_report_at. */
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
  return deps.store.transact(async tx => {
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
  });
}

async function reserveStart(
  deps: ServiceDeps,
  platforms: Platforms,
  tx: UnitOfWork,
  input: StartInput
): Promise<Reserved> {
  const instructions = requireText(input.instructions, 'instructions', 16 * 1024);
  const caller = callerOf(input);
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

  const parent = await requireStarter(tx, input, group, task, root);
  const capabilities = new Set(platforms.require(group.connection_id).connection.capabilities);

  if (input.replacementOf !== null) {
    await requireReplaced(tx, input.workspaceId, input.replacementOf, task.id, input.role);
  }

  if (input.role !== 'challenger' && (await tx.holderCount(task.id, input.role)) > 0) {
    throw new HivemindError('conflict', 'This role on this task already has a session.');
  }

  const occupancy = await tx.occupancy(input.workspaceId, group.id);
  const since = formatTime(new Date(deps.clock.now().getTime() - spawnWindowMs));
  const spawn = await tx.spawnCount(group.id, since);
  const attempt =
    input.role === 'challenger' && input.replacementOf === null
      ? 1
      : await tx.nextAttempt(task.id, input.role);
  const replacements = await tx.replacementCount(task.id, input.role);
  const onTask = await tx.liveOnTask(task.id, input.role);

  refuseStartCaps(
    group,
    workspace.limits.live_sessions,
    occupancy,
    spawn,
    attempt,
    replacements,
    onTask,
    input.role
  );

  if (input.role === 'implementer' && task.changeset_id === null) {
    task.changeset_id = deps.ids.changeset();
    await tx.updateTask(task);
  }

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
    parent_session_id: parent.parentId,
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

  if (parent.parentId !== null) await tx.touchReport(parent.parentId, now);

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
    platformInput: {
      prompt: composePrompt({
        role: input.role,
        sessionId: session.id,
        group,
        task,
        parentSessionId: parent.parentId,
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
    },
  };
}

async function requireStarter(
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

async function requireReplaced(
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

function refuseStartCaps(
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

function refuseResumeCaps(
  group: Group,
  workspaceLiveLimit: number,
  occupancy: Occupancy,
  role: SessionRole,
  onTask: number
): void {
  if (compareDecimal(group.spend, group.budget) >= 0) reach('budget', group.budget, group.spend);
  if (occupancy.live_sessions + 1 > group.caps.live_sessions) {
    reach('live_sessions', group.caps.live_sessions, occupancy.live_sessions);
  }

  if (role === 'planner' || role === 'challenger' || role === 'implementer') {
    const current =
      occupancy[
        role === 'planner' ? 'planner' : role === 'challenger' ? 'challenger' : 'implementer'
      ];

    if (current + 1 > group.caps.live_per_role[role]) {
      reach('live_per_role', group.caps.live_per_role[role], current);
    }
  } else if (onTask + 1 > group.caps.live_per_task_role[role]) {
    reach('live_per_task_role', group.caps.live_per_task_role[role], onTask);
  }

  if (occupancy.workspace_live_sessions + 1 > workspaceLiveLimit) {
    reach('workspace_live_sessions', workspaceLiveLimit, occupancy.workspace_live_sessions);
  }
}

async function completeStart(
  deps: ServiceDeps,
  tx: UnitOfWork,
  current: SessionRecord,
  startAttemptId: string,
  result: StartSessionResult
): Promise<SessionRecord> {
  await tx.lockWorkspace(current.workspace_id);
  await tx.lockGroup(current.workspace_id, current.group_id);
  const session = await tx.lockSession(current.workspace_id, current.id);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (session.end_requested_at !== null) {
    if (session.platform_session_ref === null) {
      session.platform_session_ref = result.platformSessionRef;
      session.platform_address = result.address;

      if (session.life === 'ended') session.final_usage_pending = true;

      await tx.updateSession(session);
    }

    return session;
  }

  if (session.life !== 'starting' || session.start_attempt_id !== startAttemptId) {
    if (session.life === 'start_failed' && session.platform_session_ref === null) {
      session.platform_session_ref = result.platformSessionRef;
      session.platform_address = result.address;
      session.final_usage_pending = true;
      await tx.updateSession(session);
    }

    return session;
  }

  session.life = 'live';
  session.platform_session_ref = result.platformSessionRef;
  session.platform_address = result.address;
  session.attributed_to = result.attributedTo;
  session.secret_delivered = result.secretDelivered;
  await tx.updateSession(session);

  const code = await tx.openEnrollmentCode(session.id);

  if (code !== null && code.expires_at === null) {
    code.expires_at = formatTime(new Date(deps.clock.now().getTime() + enrollmentTtlMs));
    await tx.saveEnrollmentCode(code);
  }

  return session;
}

async function compensateStart(
  deps: ServiceDeps,
  tx: UnitOfWork,
  current: SessionRecord,
  errorClass: PlatformErrorClass
): Promise<SessionRecord> {
  await tx.lockWorkspace(current.workspace_id);
  await tx.lockGroup(current.workspace_id, current.group_id);
  const session = await tx.lockSession(current.workspace_id, current.id);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (
    session.life !== 'starting' ||
    session.existence_evidence_at !== null ||
    session.end_requested_at !== null
  ) {
    return session;
  }

  const now = formatTime(deps.clock.now());

  session.life = 'start_failed';
  session.token_hash = null;
  await tx.updateSession(session);
  await tx.voidEnrollmentCodes(session.id, now);
  await tx.addOccupancy(session.workspace_id, session.group_id, occupancyFor(session.role, -1, 0));
  await appendEvent(deps, tx, {
    workspace_id: session.workspace_id,
    task_id: session.task_id,
    group_id: session.group_id,
    kind: 'session_start_failed',
    actor: { kind: 'service', id: 'hivemind-svc' },
    from_state: null,
    to_state: null,
    evidence: [],
    note: null,
    data: { session_id: session.id, error_class: errorClass },
  });

  return session;
}

async function recordEndIntent(
  deps: ServiceDeps,
  tx: UnitOfWork,
  input: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    actor:
      | { kind: 'session'; sessionId: SessionId }
      | { kind: 'person'; personId: PersonId }
      | { kind: 'service' };
    reason: string;
  }
): Promise<{ finished: boolean; session: SessionRecord }> {
  const reason = requireText(input.reason, 'reason', 4 * 1024);
  const session = await lockOwned(tx, input.workspaceId, input.sessionId);

  await authorizeEnd(tx, input.workspaceId, session, input.actor);

  if (session.life === 'ended' || session.life === 'start_failed') {
    return { finished: true, session };
  }

  if (session.end_requested_at !== null) return { finished: false, session };

  const now = formatTime(deps.clock.now());

  session.end_requested_at = now;
  session.end_actor_kind = input.actor.kind;
  session.end_actor_id =
    input.actor.kind === 'session'
      ? input.actor.sessionId
      : input.actor.kind === 'person'
        ? input.actor.personId
        : 'hivemind-svc';
  session.end_reason = reason;
  session.end_operation_id = randomText(deps);
  await tx.updateSession(session);
  await tx.voidEnrollmentCodes(session.id, now);

  return { finished: false, session };
}

async function attachPlatformRef(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);
  let found: Awaited<ReturnType<typeof handle.adapter.findByKey>>;

  try {
    found = await handle.adapter.findByKey(handle.connection, session.id, session.created_at);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError(
        'unavailable',
        'The platform did not say whether the session exists.'
      );
    }

    throw error;
  }

  if (found.outcome === 'inconclusive') {
    throw new HivemindError('unavailable', 'The platform did not say whether the session exists.');
  }

  if (found.outcome === 'absent') return session;

  return deps.store.transact(async tx => {
    const locked = await lockOwned(tx, session.workspace_id, session.id);

    if (locked.platform_session_ref === null) {
      locked.platform_session_ref = found.platformSessionRef;
      locked.platform_address = found.address;
      await tx.updateSession(locked);
    }

    return locked;
  });
}

/**
 * A compensated start can gain a platform session after the first lookup said it was absent.
 * Look again, then stop it. A stop that fails stays pending so the next attempt can finish it.
 */
async function reclaimCompensatedStart(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (session.life !== 'start_failed') return session;

  if (session.platform_session_ref !== null && session.final_usage_pending) {
    return stopCompensatedPlatform(deps, platforms, session);
  }

  if (session.platform_session_ref !== null) return session;

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);
  let found: Awaited<ReturnType<typeof handle.adapter.findByKey>>;

  try {
    found = await handle.adapter.findByKey(handle.connection, session.id, session.created_at);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError(
        'unavailable',
        'The platform did not say whether the session exists.'
      );
    }

    throw error;
  }

  if (found.outcome === 'inconclusive') {
    throw new HivemindError('unavailable', 'The platform did not say whether the session exists.');
  }

  if (found.outcome === 'absent') return session;

  const attached = await deps.store.transact(async tx => {
    const locked = await tx.lockSession(session.workspace_id, session.id);

    if (locked === null) {
      throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
    }

    if (locked.life !== 'start_failed' || locked.platform_session_ref !== null) return locked;

    locked.platform_session_ref = found.platformSessionRef;
    locked.platform_address = found.address;
    locked.final_usage_pending = true;
    await tx.updateSession(locked);

    return locked;
  });

  if (attached.platform_session_ref === null || !attached.final_usage_pending) return attached;

  return stopCompensatedPlatform(deps, platforms, attached);
}

/** Stop a platform session that appeared after recovery had already given its place back. */
async function stopCompensatedPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (
    session.life !== 'start_failed' ||
    session.platform_session_ref === null ||
    !session.final_usage_pending
  ) {
    return session;
  }

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);

  try {
    await handle.adapter.end(handle.connection, session.platform_session_ref);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError('unavailable', 'The platform did not stop the session.');
    }

    throw error;
  }

  await readFinalUsage(deps, platforms, session);

  return (await deps.store.session(session.workspace_id, session.id)) ?? session;
}

/** Stop a platform session that appeared after the row was already ended, then read its usage. */
async function settleEndedPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<SessionRecord> {
  if (
    session.life !== 'ended' ||
    session.platform_session_ref === null ||
    !session.final_usage_pending
  ) {
    return session;
  }

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) {
    throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
  }

  const handle = platforms.require(group.connection_id);

  try {
    await handle.adapter.end(handle.connection, session.platform_session_ref);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new HivemindError('unavailable', 'The platform did not stop the session.');
    }

    throw error;
  }

  await readFinalUsage(deps, platforms, session);

  return (await deps.store.session(session.workspace_id, session.id)) ?? session;
}

async function finishPlatformEnd(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord,
  crashAt: CrashPoint | undefined
): Promise<SessionRecord> {
  const resolved =
    session.platform_session_ref === null
      ? await attachPlatformRef(deps, platforms, session)
      : session;

  if (resolved.platform_session_ref !== null) {
    const group = await deps.store.group(resolved.workspace_id, resolved.group_id);

    if (group === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    const handle = platforms.require(group.connection_id);

    await handle.adapter.end(handle.connection, resolved.platform_session_ref);
  }

  if (crashAt === 'after_platform_end') throw new StoppedProcess('after_platform_end');

  const finished = await deps.store.transact(tx => finishEnd(deps, tx, resolved));
  const attached = finished.platform_session_ref;

  if (attached !== null && attached !== resolved.platform_session_ref) {
    const group = await deps.store.group(finished.workspace_id, finished.group_id);

    if (group === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    const handle = platforms.require(group.connection_id);

    try {
      await handle.adapter.end(handle.connection, attached);
    } catch (error) {
      if (error instanceof PlatformError) {
        throw new HivemindError('unavailable', 'The platform did not stop the session.');
      }

      throw error;
    }
  }

  if (finished.platform_session_ref !== null && finished.final_usage_pending) {
    await readFinalUsage(deps, platforms, finished);
  }

  return (await deps.store.session(finished.workspace_id, finished.id)) ?? finished;
}

async function finishEnd(
  deps: ServiceDeps,
  tx: UnitOfWork,
  current: SessionRecord
): Promise<SessionRecord> {
  const session = await lockOwned(tx, current.workspace_id, current.id);

  if (session.life === 'ended') return session;

  if (session.life === 'starting' || session.life === 'live') {
    await tx.addOccupancy(
      session.workspace_id,
      session.group_id,
      occupancyFor(session.role, -1, 0)
    );
  }

  const now = formatTime(deps.clock.now());

  const receiptHash = session.token_hash;

  session.life = 'ended';
  session.ended_at = now;
  session.token_hash = null;
  session.final_usage_pending = session.platform_session_ref !== null;
  await tx.updateSession(session);

  if (receiptHash !== null) {
    await tx.insertIdempotency({
      workspaceId: session.workspace_id,
      callerKind: 'end_receipt',
      callerId: receiptHash,
      route: 'session.end',
      key: 'token',
      bodyHash: receiptHash,
      recordId: session.id,
      completed: true,
      at: now,
    });
  }
  await tx.voidEnrollmentCodes(session.id, now);
  await appendEvent(deps, tx, {
    workspace_id: session.workspace_id,
    task_id: session.task_id,
    group_id: session.group_id,
    kind: 'session_ended',
    actor: {
      kind: session.end_actor_kind ?? 'service',
      id: session.end_actor_id ?? 'hivemind-svc',
    },
    from_state: null,
    to_state: null,
    evidence: [],
    note: session.end_reason,
    data: { session_id: session.id, reason: session.end_reason },
  });

  return session;
}

async function authorizeEnd(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  target: SessionRecord,
  actor:
    | { kind: 'session'; sessionId: SessionId }
    | { kind: 'person'; personId: PersonId }
    | { kind: 'service' }
): Promise<void> {
  const task = await tx.lockTask(workspaceId, target.task_id);

  if (task === null) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  if (actor.kind === 'service') return;

  if (actor.kind === 'person') {
    const person = await tx.person(workspaceId, actor.personId);
    const group = await tx.lockGroup(workspaceId, target.group_id);

    if (person === null || group === null) {
      throw new HivemindError('forbidden', 'That person cannot end the session.');
    }

    if (person.id !== group.owner_person_id && person.workspace_role !== 'administrator') {
      throw new HivemindError(
        'forbidden',
        'Only the owner or an administrator can end the session.'
      );
    }

    return;
  }

  if (actor.sessionId === target.id) {
    const decision = evaluatePolicy({
      role: target.role,
      action: 'end_self',
      released: target.life === 'released',
      taskKind: task.parent_id === null ? 'root' : 'child',
      taskState: task.state,
      relation: 'own',
      rootState:
        task.parent_id === null
          ? task.state
          : (await rootTask(tx, workspaceId, target.group_id)).state,
      targetRole: target.role,
      targetStartedByCaller: false,
      targetTaskClosed: isClosedState(task.state),
    });

    if (!decision.allowed) {
      throw new HivemindError('policy_denied', decision.message, {
        role: decision.role,
        action: decision.action,
      });
    }

    return;
  }

  const caller = await tx.lockSession(workspaceId, actor.sessionId);

  if (caller === null || caller.group_id !== target.group_id) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  if (caller.life !== 'live' && caller.life !== 'starting') {
    throw new HivemindError(
      'session_not_active',
      'The session cannot end a member from this life.',
      {
        life: caller.life,
      }
    );
  }

  const root = await rootTask(tx, workspaceId, target.group_id);
  const decision = evaluatePolicy({
    role: caller.role,
    action: 'end_other',
    released: false,
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: caller.task_id === target.task_id ? 'own' : 'other',
    rootState: root.state,
    targetRole: target.role,
    targetStartedByCaller: target.parent_session_id === caller.id,
    targetTaskClosed: isClosedState(task.state),
  });

  if (!decision.allowed) {
    throw new HivemindError('policy_denied', decision.message, {
      role: decision.role,
      action: decision.action,
    });
  }
}

async function readFinalUsage(
  deps: ServiceDeps,
  platforms: Platforms,
  session: SessionRecord
): Promise<void> {
  if (session.platform_session_ref === null) return;

  const group = await deps.store.group(session.workspace_id, session.group_id);

  if (group === null) return;

  try {
    const reading = await platforms
      .require(group.connection_id)
      .adapter.readUsage(
        platforms.require(group.connection_id).connection,
        session.platform_session_ref
      );

    await deps.store.transact(async tx => {
      await tx.lockWorkspace(session.workspace_id);
      const groupRow = await tx.lockGroup(session.workspace_id, session.group_id);
      const locked = await tx.lockSession(session.workspace_id, session.id);

      if (locked === null || groupRow === null) return;

      const next = decimalFromNumber(reading);
      const previous = locked.usage === null ? '0' : canonicalizeDecimal(locked.usage);
      const increase = subtractDecimal(next, previous);

      if (compareDecimal(increase, '0') > 0) {
        groupRow.spend = addDecimal(groupRow.spend, increase);
        await tx.updateGroup(groupRow);
      }

      locked.usage = compareDecimal(next, previous) > 0 ? next : previous;
      locked.final_usage_pending = false;
      await tx.updateSession(locked);
    });
  } catch (error) {
    if (error instanceof PlatformError) return;

    throw error;
  }
}

async function lockOwned(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<SessionRecord> {
  const peeked = await tx.sessionById(sessionId);

  if (peeked === null || peeked.workspace_id !== workspaceId) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  await tx.lockWorkspace(workspaceId);
  await tx.lockGroup(workspaceId, peeked.group_id);
  await rootTask(tx, workspaceId, peeked.group_id);

  const task = await tx.lockTask(workspaceId, peeked.task_id);

  if (task === null) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  const session = await tx.lockSession(workspaceId, sessionId);

  if (session === null) {
    throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
  }

  return session;
}

async function rootTask(tx: UnitOfWork, workspaceId: WorkspaceId, groupId: GroupId): Promise<Task> {
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

async function requireLiveCaller(
  tx: UnitOfWork,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<SessionRecord> {
  const session = await tx.lockSession(workspaceId, sessionId);

  if (session === null || session.token_hash === null) {
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

async function noteBadCode(tx: UnitOfWork, sessionId: SessionId, now: string): Promise<void> {
  const open = await tx.openEnrollmentCode(sessionId);

  if (open === null) return;

  open.attempts += 1;

  if (open.attempts >= 5) open.voided_at = now;

  await tx.saveEnrollmentCode(open);
}

async function storedToken(secret: string, response: unknown): Promise<string | null> {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return null;

  const sealed = Reflect.get(response, 'sealed');

  if (typeof sealed !== 'string' || sealed.length === 0) return null;

  return openText(secret, sealed);
}

function codeExpired(deps: ServiceDeps, expiresAt: string | null): boolean {
  if (expiresAt === null) return false;

  return deps.clock.now().getTime() >= parseTime(expiresAt).getTime();
}

function callerOf(input: StartInput): { kind: 'person' | 'session'; id: string } {
  if (input.actor.kind === 'person') return { kind: 'person', id: input.actor.personId };

  return { kind: 'session', id: input.actor.sessionId };
}

async function storedOutcome(deps: ServiceDeps, session: SessionRecord): Promise<StartOutcome> {
  if (session.life !== 'start_failed') return outcomeFrom(session);

  const events = await deps.store.events(session.workspace_id, session.group_id);
  const failed = events.findLast(
    event => event.kind === 'session_start_failed' && event.data.session_id === session.id
  );
  const recorded = failed?.data.error_class;

  return {
    outcome: 'refused',
    session,
    errorClass: isPlatformErrorClass(recorded) ? recorded : 'invalid',
  };
}

function isPlatformErrorClass(value: unknown): value is PlatformErrorClass {
  return (
    value === 'auth' ||
    value === 'rate_limited' ||
    value === 'quota' ||
    value === 'invalid' ||
    value === 'not_found' ||
    value === 'unavailable'
  );
}

function outcomeFrom(session: SessionRecord): StartOutcome {
  if (session.life === 'starting') return { outcome: 'start_pending', session };
  if (session.life === 'start_failed') {
    return { outcome: 'refused', session, errorClass: 'invalid' };
  }
  if (session.life === 'ended') return { outcome: 'ended', session };
  if (session.life === 'released') return { outcome: 'released', session };

  return { outcome: 'live', session };
}

function occupancyFor(role: SessionRole, live: number, total: number): OccupancyDelta {
  return {
    live_sessions: live,
    planner: role === 'planner' ? live : 0,
    challenger: role === 'challenger' ? live : 0,
    implementer: role === 'implementer' ? live : 0,
    total_sessions: total,
  };
}

function reach(cap: string, limit: number | string, current: number | string): never {
  throw new HivemindError(
    'cap_reached',
    `The ${cap} cap is ${limit}. The current value is ${current}.`,
    {
      cap,
      limit,
      current,
    }
  );
}

function requireText(value: string, field: string, maxBytes: number): string {
  if (value.trim().length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new HivemindError('validation_failed', `The ${field} is missing or too long.`, { field });
  }

  return value;
}

function roleLabel(role: SessionRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function randomText(deps: ServiceDeps): string {
  return Buffer.from(deps.random.bytes(16)).toString('base64url');
}
