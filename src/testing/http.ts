import { expect } from 'bun:test';
import { checkoutGroup } from '@/testing/fixtures.ts';

export type JsonResponse = { status: number; body: Record<string, unknown> };

type RunningServer = { url: string };

export async function sendJson(
  server: RunningServer,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<JsonResponse> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;

  return { status: response.status, body: parsed };
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Assert the status. A mismatch prints the response body, so the reason is in the failure. */
export function expectStatus(response: JsonResponse, expectedStatus: number): void {
  expect({ status: response.status, body: response.body }).toMatchObject({
    status: expectedStatus,
  });
}

export async function bootstrapCreatorKey(
  server: RunningServer,
  bootstrapSecret: string
): Promise<string> {
  const administrator = await sendJson(
    server,
    'POST',
    '/v1/bootstrap/administrator',
    { display_name: 'Ada' },
    bearer(bootstrapSecret)
  );

  expectStatus(administrator, 201);

  const key = await sendJson(
    server,
    'POST',
    '/v1/bootstrap/keys',
    { name: 'creator', role: 'creator' },
    bearer(bootstrapSecret)
  );

  expectStatus(key, 201);

  return String(key.body.secret);
}

export function createCheckoutGroup(
  server: RunningServer,
  creatorKey: string,
  idempotencyKey: string,
  overrides?: Record<string, unknown>
): Promise<JsonResponse> {
  return sendJson(
    server,
    'POST',
    '/v1/groups',
    { ...checkoutGroup, ...overrides },
    { ...bearer(creatorKey), 'idempotency-key': idempotencyKey }
  );
}
