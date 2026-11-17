import type { ServiceDeps } from '@/core/deps.ts';
import { reportTransition } from '@/core/report-records.ts';
import { addTaskNote, editChildTask } from '@/core/session-activity.ts';
import { createChildTask } from '@/core/task-records.ts';
import { HivemindError } from '@/domain/errors.ts';
import { requireTaskId } from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { HttpOptions } from '@/http/respond.ts';
import {
  json,
  readEvidence,
  readMode,
  readNumber,
  readState,
  readString,
  requireIdempotency,
} from '@/http/respond.ts';

export async function taskCollection(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string,
  active: SessionRecord
): Promise<Response | null> {
  const { deps } = options;
  if (request.method === 'GET' && path === '/v1/tasks') {
    return json(200, { tasks: await deps.store.tasks(active.workspace_id, active.group_id) });
  }

  if (request.method === 'POST' && path === '/v1/tasks') {
    const created = await createChildTask(deps, {
      workspaceId: active.workspace_id,
      groupId: active.group_id,
      actor: { sessionId: active.id },
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
  return null;
}

export async function taskHistory(
  options: HttpOptions,
  request: Request,
  path: string,
  active: SessionRecord
): Promise<Response | null> {
  const history = path.match(/^\/v1\/tasks\/([^/]+)\/events$/);

  if (history?.[1] === undefined || request.method !== 'GET') return null;

  const id = requireTaskId(decodeURIComponent(history[1]));

  await oneTask(options.deps, active, id);

  const events = await options.deps.store.events(active.workspace_id, active.group_id);

  return json(200, { events: events.filter(event => event.task_id === id) });
}

export async function taskEvents(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string,
  active: SessionRecord
): Promise<Response | null> {
  const { deps } = options;
  const transition = path.match(/^\/v1\/tasks\/([^/]+)\/transitions$/);
  const note = path.match(/^\/v1\/tasks\/([^/]+)\/notes$/);

  if (transition?.[1] && request.method === 'POST') {
    const reported = await reportTransition(deps, {
      workspaceId: active.workspace_id,
      groupId: active.group_id,
      taskId: requireTaskId(decodeURIComponent(transition[1])),
      expectedVersion: readNumber(body, 'expected_version'),
      actor: { kind: 'session', sessionId: active.id },
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
  return null;
}

export async function oneTask(
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
