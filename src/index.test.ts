import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHivemind } from './index.ts';

test('hivemind-svc answers health checks and shows the bootstrap key once', async () => {
  const started = await startHivemind({ port: 0, dataDir: null, responseKey: 'test-response-key' });
  const health = await fetch(`${started.url}/healthz`);
  const ready = await fetch(`${started.url}/readyz`);

  expect(health.status).toBe(200);
  expect(ready.status).toBe(200);
  expect(started.bootstrapSecret?.startsWith('opk_')).toBe(true);

  await started.stop();
});

test('a restarted process keeps the connection that existing groups use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hivemind-'));
  const first = await startHivemind({
    port: 0,
    dataDir: directory,
    responseKey: 'test-response-key',
  });
  const admin = await fetch(`${first.url}/v1/bootstrap/administrator`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${first.bootstrapSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ display_name: 'Ada' }),
  });

  expect(admin.status).toBe(201);

  const keyResponse = await fetch(`${first.url}/v1/bootstrap/keys`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${first.bootstrapSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'creator', role: 'creator' }),
  });
  const key = (await keyResponse.json()) as { secret: string };
  const created = await fetch(`${first.url}/v1/groups`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key.secret}`,
      'content-type': 'application/json',
      'idempotency-key': 'restart-group',
    },
    body: JSON.stringify({
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    }),
  });
  const createdBody = (await created.json()) as { group: { id: string; connection_id: string } };

  expect(created.status).toBe(201);

  await first.stop();

  const second = await startHivemind({
    port: 0,
    dataDir: directory,
    responseKey: 'test-response-key',
  });
  const again = await fetch(`${second.url}/v1/groups`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key.secret}`,
      'content-type': 'application/json',
      'idempotency-key': 'restart-group-2',
    },
    body: JSON.stringify({
      name: 'Payments',
      goal: 'Record the second group after a restart.',
      budget: '80',
      instructions: 'Plan the payments work.',
    }),
  });
  const againBody = (await again.json()) as { group: { connection_id: string } };

  expect(again.status).toBe(201);
  expect(againBody.group.connection_id).toBe(createdBody.group.connection_id);

  await second.stop();
});
