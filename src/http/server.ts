import { randomUUID } from 'node:crypto';
import { noteActivity } from '@/core/session-activity.ts';
import { HivemindError } from '@/domain/errors.ts';
import { memberRoutes } from '@/http/member-routes.ts';
import { sessionMessageRoute } from '@/http/message-routes.ts';
import { openRoute } from '@/http/open-routes.ts';
import { fail, type HttpOptions, maxBody, parseJson } from '@/http/respond.ts';
import { selfRoute } from '@/http/self-routes.ts';
import { requireSession } from '@/http/session-auth.ts';
import { taskCollection, taskEvents, taskHistory } from '@/http/task-routes.ts';

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
  const opened = await openRoute(options, request, path, body, raw);

  if (opened) return opened;

  return sessionRoutes(options, request, path, body, raw);
}

async function sessionRoutes(
  options: HttpOptions,
  request: Request,
  path: string,
  body: Record<string, unknown>,
  raw: string
): Promise<Response> {
  const { deps } = options;
  const sessionPath =
    path.startsWith('/v1/session') ||
    path.startsWith('/v1/tasks') ||
    path.startsWith('/v1/sessions') ||
    path === '/v1/group' ||
    path === '/v1/messages' ||
    path.startsWith('/v1/waits');

  if (!sessionPath) throw new HivemindError('not_found', 'No route matches the request.');

  const caller = await requireSession(options, request);
  const reports =
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    path !== '/v1/messages' &&
    path !== '/v1/session/escalate' &&
    !path.startsWith('/v1/waits');
  const active = await noteActivity(deps, caller.workspace_id, caller.id, reports);
  return (
    (await selfRoute(options, request, path, body, raw, active)) ??
    (await taskCollection(options, request, path, body, raw, active)) ??
    (await taskHistory(options, request, path, active)) ??
    (await taskEvents(options, request, path, body, raw, active)) ??
    (await memberRoutes(options, request, path, body, raw, active)) ??
    (await sessionMessageRoute(options, request, path, body, raw, active)) ??
    missing()
  );
}

function missing(): never {
  throw new HivemindError('not_found', 'No route matches the request.');
}
