import { randomUUID } from 'node:crypto';
import type { ServiceDeps } from '@/core/deps.ts';
import { createFirstAdministrator, createOperatorKey } from '@/core/installation.ts';
import { createChildTask, reportTransition } from '@/core/records.ts';
import {
  addTaskNote,
  editChildTask,
  endSession,
  enroll,
  noteActivity,
  openGroup,
  releaseSession,
  resumeSession,
  startSession,
} from '@/core/sessions.ts';
import type { ErrorCode } from '@/domain/errors.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  type ConnectionId,
  type PersonId,
  requirePersonId,
  requireSessionId,
  requireTaskId,
  requireWorkspaceId,
  type SessionId,
  type WorkspaceId,
} from '@/domain/ids.ts';
import type { EvidenceEntry, SessionRecord, TaskState, VerificationMode } from '@/domain/model.ts';
import { isSessionRole, isTaskState, isVerificationMode } from '@/domain/model.ts';
import type { PlatformErrorClass } from '@/domain/platform.ts';
import { sha256Hex } from '@/domain/secret.ts';
import { parseTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

const maxBody = 256 * 1024;

type HttpOptions = {
  deps: ServiceDeps;
  platforms: Platforms;
  connectionId: ConnectionId;
  port?: number;
};

type KeyCaller = {
  kind: 'key';
  personId: PersonId;
  role: string;
  workspaceId: WorkspaceId;
};

export async function startHttp(options: HttpOptions): Promise<{
  port: number;
  url: string;
  stop: () => void;
}> {
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: '127.0.0.1',
    maxRequestBodySize: maxBody,
    fetch(request) {
      return handle(options, request);
    },
  });

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}

async function handle(options: HttpOptions, request: Request): Promise<Response> {
  const requestId = randomUUID();

  try {
    const url = new URL(request.url);
    const bodyText =
      request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();

    if (Buffer.byteLength(bodyText) > maxBody) {
      throw new HivemindError('payload_too_large', 'The request body is too large.', {
        limit: maxBody,
      });
    }

    const body = bodyText.length === 0 ? {} : parseJson(bodyText);
    const response = await route(options, request, url.pathname, body, bodyText);

    response.headers.set('x-request-id', requestId);

    return response;
  } catch (error) {
    if (error instanceof HivemindError) return fail(error, requestId);

    return fail(
      new HivemindError('unavailable', 'The service could not complete the request.'),
      requestId
    );
  }
}

async function route(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string
): Promise<Response> {
  const { deps } = options;

  if (request.method === 'GET' && path === '/healthz') return json(200, { status: 'ok' });
  if (request.method === 'GET' && path === '/readyz') {
    await deps.store.transact(tx => tx.countWorkspaces());

    return json(200, { status: 'ok' });
  }

  if (request.method === 'POST' && path === '/v1/session/enroll') {
    if (bearer(request) !== null) {
      throw new HivemindError(
        'ambiguous_credentials',
        'The request carries two kinds of credential.'
      );
    }

    const sessionId = requireSessionId(readString(body, 'session_id'));
    const code = readString(body, 'code');
    const enrolled = await enroll(deps, {
      sessionId,
      code,
      idempotencyKey: requireIdempotency(request),
      bodyHash: sha256Hex(raw),
    });

    return json(200, { token: enrolled.token });
  }

  if (request.method === 'POST' && path === '/v1/bootstrap/administrator') {
    const secret = requireBearer(request);
    const person = await createFirstAdministrator(deps, {
      bootstrapSecret: secret,
      displayName: readString(body, 'display_name'),
    });

    return json(201, { person });
  }

  if (request.method === 'POST' && path === '/v1/bootstrap/keys') {
    const secret = requireBearer(request);
    const role = readString(body, 'role');

    if (role !== 'reader' && role !== 'creator' && role !== 'administrator') {
      throw new HivemindError('validation_failed', 'The key role is not valid.', { field: 'role' });
    }

    const created = await createOperatorKey(deps, {
      bootstrapSecret: secret,
      name: readString(body, 'name'),
      role,
      expiresAt: readOptionalExpiry(body),
    });

    return json(201, {
      secret: created.secret,
      key: { id: created.record.id, name: created.record.name, role: created.record.role },
    });
  }

  if (request.method === 'POST' && path === '/v1/groups') {
    const key = await requireKey(options, request);
    const created = await openGroup(deps, options.platforms, {
      workspaceId: key.workspaceId,
      personId: key.personId,
      name: readString(body, 'name'),
      goal: readString(body, 'goal'),
      budget: readString(body, 'budget'),
      connectionId: options.connectionId,
      verificationMode: readMode(body.verification_mode),
      notes: [],
      instructions: readString(body, 'instructions'),
      idempotencyKey: requireIdempotency(request),
      bodyHash: sha256Hex(raw),
    });

    if (created.outcome === 'start_pending') return pending(created.session);
    if (created.outcome === 'refused') throw platformFailure(created.errorClass ?? 'invalid');

    return json(201, {
      group: created.group,
      root: created.root,
      session: publicSession(created.session),
    });
  }

  const sessionPath =
    path.startsWith('/v1/session') ||
    path.startsWith('/v1/tasks') ||
    path.startsWith('/v1/sessions') ||
    path === '/v1/group';

  if (!sessionPath) throw new HivemindError('not_found', 'No route matches the request.');

  const caller = await requireSession(options, request);
  const active = await noteActivity(deps, caller.workspace_id, caller.id, request.method !== 'GET');

  if (request.method === 'GET' && path === '/v1/session') {
    const group = await deps.store.group(active.workspace_id, active.group_id);

    return json(200, {
      id: active.id,
      role: active.role,
      task_id: active.task_id,
      group_id: active.group_id,
      group_name: group?.name ?? '',
      life: active.life,
      parent_session_id: active.parent_session_id,
      attempt: active.attempt,
      title: active.title,
    });
  }

  if (request.method === 'POST' && path === '/v1/session/release') {
    return json(200, {
      session: publicSession(
        await releaseSession(deps, {
          workspaceId: active.workspace_id,
          sessionId: active.id,
          idempotency: { key: requireIdempotency(request), bodyHash: sha256Hex(raw) },
        })
      ),
    });
  }

  if (request.method === 'POST' && path === '/v1/session/resume') {
    return json(200, {
      session: publicSession(
        await resumeSession(deps, {
          workspaceId: active.workspace_id,
          sessionId: active.id,
          idempotency: { key: requireIdempotency(request), bodyHash: sha256Hex(raw) },
        })
      ),
    });
  }

  if (request.method === 'POST' && path === '/v1/session/end') {
    if (active.life === 'ended') return json(200, { session: publicSession(active) });

    const ended = await endSession(deps, options.platforms, {
      workspaceId: active.workspace_id,
      sessionId: active.id,
      actor: { kind: 'session', sessionId: active.id },
      reason: readString(body, 'reason'),
    });

    return json(200, { session: publicSession(ended) });
  }

  if (request.method === 'GET' && path === '/v1/group') {
    const group = await deps.store.group(active.workspace_id, active.group_id);

    if (group === null)
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');

    return json(200, { group });
  }

  if (request.method === 'GET' && path === '/v1/tasks') {
    return json(200, { tasks: await deps.store.tasks(active.workspace_id, active.group_id) });
  }

  if (request.method === 'POST' && path === '/v1/tasks') {
    if (active.role !== 'planner') {
      throw new HivemindError(
        'policy_denied',
        `The ${active.role} role cannot create_child_task.`,
        {
          role: active.role,
          action: 'create_child_task',
        }
      );
    }

    const created = await createChildTask(deps, {
      workspaceId: active.workspace_id,
      groupId: active.group_id,
      actor: {
        role: 'planner',
        sessionId: active.id,
        live: active.life === 'live' || active.life === 'starting',
      },
      title: readString(body, 'title'),
      description: readString(body, 'description'),
      verificationMode: readMode(body.verification_mode),
      dependsOn: [],
      idempotency: {
        key: requireIdempotency(request),
        bodyHash: sha256Hex(raw),
        callerKind: 'session',
        callerId: active.id,
        route: 'POST /v1/tasks',
      },
    });

    return json(201, { task: created.task });
  }

  const taskEvents = path.match(/^\/v1\/tasks\/([^/]+)\/events$/);

  if (taskEvents?.[1] && request.method === 'GET') {
    const id = requireTaskId(decodeURIComponent(taskEvents[1]));

    await oneTask(deps, active, id);

    const events = await deps.store.events(active.workspace_id, active.group_id);

    return json(200, { events: events.filter(event => event.task_id === id) });
  }

  const taskId = path.match(/^\/v1\/tasks\/([^/]+)$/);

  if (taskId?.[1] && request.method === 'GET') {
    return json(200, {
      task: await oneTask(deps, active, requireTaskId(decodeURIComponent(taskId[1]))),
    });
  }

  if (taskId?.[1] && request.method === 'PATCH') {
    const task = await editChildTask(deps, {
      workspaceId: active.workspace_id,
      sessionId: active.id,
      taskId: requireTaskId(decodeURIComponent(taskId[1])),
      title: typeof body.title === 'string' ? body.title : null,
      description: typeof body.description === 'string' ? body.description : null,
    });

    return json(200, { task });
  }

  const transition = path.match(/^\/v1\/tasks\/([^/]+)\/transitions$/);
  const note = path.match(/^\/v1\/tasks\/([^/]+)\/notes$/);

  if (transition?.[1] && request.method === 'POST') {
    const reported = await reportTransition(deps, {
      workspaceId: active.workspace_id,
      groupId: active.group_id,
      taskId: requireTaskId(decodeURIComponent(transition[1])),
      expectedVersion: readNumber(body, 'expected_version'),
      actor: {
        kind: 'session',
        role: active.role,
        sessionId: active.id,
        live: active.life !== 'released',
      },
      to: readState(body.to),
      note: readString(body, 'note'),
      evidence: readEvidence(body.evidence),
      nextVerificationMode: readMode(body.verification_mode),
      idempotency: {
        key: requireIdempotency(request),
        bodyHash: sha256Hex(raw),
        callerKind: 'session',
        callerId: active.id,
        route: path,
      },
    });

    return json(200, { task: reported.task, group: reported.group });
  }

  if (note?.[1] && request.method === 'POST') {
    const task = await addTaskNote(deps, {
      workspaceId: active.workspace_id,
      sessionId: active.id,
      taskId: requireTaskId(decodeURIComponent(note[1])),
      note: readString(body, 'note'),
      evidence: readEvidence(body.evidence),
      idempotency: {
        key: requireIdempotency(request),
        bodyHash: sha256Hex(raw),
        callerKind: 'session',
        callerId: active.id,
        route: `POST /v1/tasks/${decodeURIComponent(note[1])}/notes`,
      },
    });

    return json(201, { task });
  }

  if (request.method === 'GET' && path === '/v1/sessions') {
    const sessions = await deps.store.sessions(active.workspace_id, active.group_id);

    return json(200, { sessions: sessions.map(publicSession) });
  }

  if (request.method === 'POST' && path === '/v1/sessions') {
    return memberStart(options, active, body, raw, request, null);
  }

  const replace = path.match(/^\/v1\/sessions\/([^/]+)\/replace$/);
  const end = path.match(/^\/v1\/sessions\/([^/]+)\/end$/);

  if (replace?.[1] && request.method === 'POST') {
    const target = await deps.store.session(
      active.workspace_id,
      requireSessionId(decodeURIComponent(replace[1]))
    );

    if (target === null || target.group_id !== active.group_id) {
      throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
    }

    return memberStart(
      options,
      active,
      { ...body, role: target.role, task_id: target.task_id },
      raw,
      request,
      target.id
    );
  }

  if (end?.[1] && request.method === 'POST') {
    const targetId = requireSessionId(decodeURIComponent(end[1]));

    if (active.life === 'ended' && active.id === targetId) {
      return json(200, { session: publicSession(active) });
    }

    const ended = await endSession(deps, options.platforms, {
      workspaceId: active.workspace_id,
      sessionId: targetId,
      actor: { kind: 'session', sessionId: active.id },
      reason: readString(body, 'reason'),
    });

    return json(200, { session: publicSession(ended) });
  }

  throw new HivemindError('not_found', 'No route matches the request.');
}

async function memberStart(
  options: HttpOptions,
  active: SessionRecord,
  body: Record<string, unknown>,
  raw: string,
  request: Request,
  replacementOf: SessionId | null
): Promise<Response> {
  const role = readString(body, 'role');

  if (!isSessionRole(role)) {
    throw new HivemindError('validation_failed', 'The role is not valid.', { field: 'role' });
  }

  const started = await startSession(options.deps, options.platforms, {
    workspaceId: active.workspace_id,
    groupId: active.group_id,
    taskId: requireTaskId(readString(body, 'task_id')),
    role,
    instructions: readString(body, 'instructions'),
    actor: { kind: 'session', sessionId: active.id },
    idempotencyKey: requireIdempotency(request),
    bodyHash: sha256Hex(raw),
    replacementOf,
  });

  if (started.outcome === 'start_pending') return pending(started.session);
  if (started.outcome === 'refused') throw platformFailure(started.errorClass ?? 'invalid');
  if (started.outcome === 'ended' || started.outcome === 'released') {
    return json(200, { session: publicSession(started.session) });
  }

  return json(201, { session: publicSession(started.session) });
}

async function oneTask(
  deps: ServiceDeps,
  session: SessionRecord,
  taskId: ReturnType<typeof requireTaskId>
) {
  const tasks = await deps.store.tasks(session.workspace_id, session.group_id);
  const task = tasks.find(item => item.id === taskId);

  if (task === undefined) {
    throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
  }

  return task;
}

async function requireSession(options: HttpOptions, request: Request): Promise<SessionRecord> {
  const token = requireBearer(request);

  if (!token.startsWith('ses_')) {
    throw new HivemindError('unauthenticated', 'The session token is not valid.');
  }

  const hash = sha256Hex(token);
  const session = await options.deps.store.transact(tx => tx.sessionByTokenHash(hash));

  if (
    session !== null &&
    session.token_hash !== null &&
    session.life !== 'ended' &&
    session.life !== 'start_failed'
  ) {
    if (session.end_requested_at !== null && !allowedWhileEnding(request)) {
      throw new HivemindError(
        'session_not_active',
        'The session is ending and cannot start new work.',
        { life: session.life }
      );
    }

    return session;
  }

  const ended = await options.deps.store.transact(tx => tx.sessionByEndReceipt(hash));

  if (ended !== null && confirmsEndedSession(request, ended.id)) return ended;

  throw new HivemindError('unauthenticated', 'The session token is not valid.');
}

function confirmsEndedSession(request: Request, sessionId: string): boolean {
  if (request.method !== 'POST') return false;

  const path = new URL(request.url).pathname;

  if (path === '/v1/session/end') return true;

  const match = /^\/v1\/sessions\/([^/]+)\/end$/.exec(path);

  const target = match?.[1];

  return target !== undefined && decodeURIComponent(target) === sessionId;
}

function allowedWhileEnding(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;

  if (request.method !== 'POST') return false;

  const path = new URL(request.url).pathname;

  return path === '/v1/session/end' || /^\/v1\/sessions\/[^/]+\/end$/.test(path);
}

async function requireKey(options: HttpOptions, request: Request): Promise<KeyCaller> {
  const secret = requireBearer(request);

  if (!secret.startsWith('opk_')) {
    throw new HivemindError('unauthenticated', 'The operator key is not valid.');
  }

  const record = await options.deps.store.transact(tx => tx.operatorKeyByHash(sha256Hex(secret)));
  const now = options.deps.clock.now().getTime();

  if (
    record === null ||
    record.revoked_at !== null ||
    record.person_id === null ||
    (record.expires_at !== null && now >= parseTime(record.expires_at).getTime()) ||
    (record.role !== 'creator' && record.role !== 'administrator')
  ) {
    throw new HivemindError('unauthenticated', 'The operator key is not valid.');
  }

  return {
    kind: 'key',
    personId: requirePersonId(record.person_id),
    role: record.role,
    workspaceId: requireWorkspaceId(record.workspace_id),
  };
}

function requireBearer(request: Request): string {
  const token = bearer(request);

  if (token === null) throw new HivemindError('unauthenticated', 'The request has no credential.');

  return token;
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');

  if (header === null) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header);

  return match?.[1] ?? null;
}

function requireIdempotency(request: Request): string {
  const key = request.headers.get('idempotency-key');

  if (key === null || key.trim().length === 0) {
    throw new HivemindError('validation_failed', 'The request needs an Idempotency-Key header.', {
      field: 'Idempotency-Key',
    });
  }

  return key;
}

function pending(session: SessionRecord): Response {
  return json(202, {
    error: {
      code: 'start_pending',
      message: 'The platform did not say whether it started the session.',
      details: { session_id: session.id },
    },
    session_id: session.id,
    session: publicSession(session),
  });
}

function publicSession(session: SessionRecord): Omit<SessionRecord, 'token_hash'> {
  const { token_hash: _token, ...rest } = session;

  return rest;
}

function platformFailure(errorClass: PlatformErrorClass): HivemindError {
  if (errorClass === 'auth') {
    return new HivemindError('platform_auth_failed', 'The platform refused the credential.');
  }

  if (errorClass === 'rate_limited') {
    return new HivemindError('platform_rate_limited', 'The platform asked the service to slow.');
  }

  if (errorClass === 'quota') {
    return new HivemindError('platform_quota', 'The platform account reached a limit.');
  }

  return new HivemindError('validation_failed', 'The platform rejected the start.');
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HivemindError('validation_failed', 'The request body must be a JSON object.');
    }

    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HivemindError) throw error;

    throw new HivemindError('validation_failed', 'The request body is not JSON.');
  }
}

function readOptionalExpiry(body: Record<string, unknown>): string | null {
  if (!('expires_at' in body) || body.expires_at === null) return null;

  if (typeof body.expires_at !== 'string') {
    throw new HivemindError('validation_failed', 'The expires_at is not valid.', {
      field: 'expires_at',
    });
  }

  return body.expires_at;
}

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== 'string') {
    throw new HivemindError('validation_failed', `The ${field} is missing.`, { field });
  }

  return value;
}

function readNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HivemindError('validation_failed', `The ${field} is missing.`, { field });
  }

  return value;
}

function readState(value: unknown): TaskState {
  if (typeof value !== 'string' || !isTaskState(value)) {
    throw new HivemindError('validation_failed', 'The target state is not valid.', { field: 'to' });
  }

  return value;
}

function readMode(value: unknown): VerificationMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && isVerificationMode(value)) return value;

  throw new HivemindError('validation_failed', 'The verification mode is not valid.', {
    field: 'verification_mode',
  });
}

function readEvidence(value: unknown): EvidenceEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HivemindError('validation_failed', 'Evidence must be a list.', { field: 'evidence' });
  }

  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new HivemindError('validation_failed', 'An evidence entry is not valid.', {
        field: 'evidence',
      });
    }

    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const label = record.label;
    const item = record.value;

    if (
      (kind !== 'address' && kind !== 'text') ||
      typeof label !== 'string' ||
      typeof item !== 'string'
    ) {
      throw new HivemindError('validation_failed', 'An evidence entry is not valid.', {
        field: 'evidence',
      });
    }

    return { kind, label, value: item };
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(error: HivemindError, requestId: string): Response {
  const response = json(statusFor(error.code), {
    error: { code: error.code, message: error.message, details: error.details },
    request_id: requestId,
  });

  response.headers.set('x-request-id', requestId);

  return response;
}

function statusFor(code: ErrorCode): number {
  if (code === 'unauthenticated') return 401;
  if (code === 'forbidden' || code === 'policy_denied' || code === 'session_not_active') return 403;
  if (code === 'not_found') return 404;
  if (code === 'validation_failed' || code === 'evidence_required') return 422;
  if (code === 'payload_too_large') return 413;
  if (code === 'start_pending') return 202;
  if (code === 'platform_unavailable' || code === 'platform_auth_failed') return 502;
  if (code === 'platform_rate_limited' || code === 'unavailable') return 503;
  if (code === 'ambiguous_credentials') return 400;

  return 409;
}
