import { expect, test } from 'bun:test';
import { requirePresent } from '@/testing/assertions.ts';
import { testResponseKey } from '@/testing/deps.ts';
import { createTemporaryDirectory } from '@/testing/files.ts';
import { bootstrapCreatorKey, createCheckoutGroup, expectStatus } from '@/testing/http.ts';
import { runAfterTest } from '@/testing/teardown.ts';
import { startHivemind } from './index.ts';

/**
 * Start hivemind-svc and stop it after the test, even when an assertion fails first.
 *
 * <p>Closing a PGlite database twice throws, so `stop` ignores calls after the first. That lets a
 * test stop the service itself, as the restart test must, without the teardown stopping it again.
 */
async function startHivemindAfterTest(options: Parameters<typeof startHivemind>[0]) {
  const started = await startHivemind(options);
  let alreadyStopped = false;

  async function stopOnce(): Promise<void> {
    if (alreadyStopped) return;

    alreadyStopped = true;
    await started.stop();
  }

  runAfterTest(stopOnce);

  return { ...started, stop: stopOnce };
}

test(
  'hivemind-svc answers health checks and shows the bootstrap key once',
  async () => {
    const started = await startHivemindAfterTest({
      port: 0,
      dataDir: null,
      responseKey: testResponseKey,
    });
    const health = await fetch(`${started.url}/healthz`);
    const ready = await fetch(`${started.url}/readyz`);

    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(started.bootstrapSecret?.startsWith('opk_')).toBe(true);
  },
  // The first boot compiles PGlite. On CI that can take longer than Bun's 5 second default.
  { timeout: 20_000 }
);

test('a restarted process keeps the connection that existing groups use', async () => {
  const directory = await createTemporaryDirectory();
  const first = await startHivemindAfterTest({
    port: 0,
    dataDir: directory,
    responseKey: testResponseKey,
  });
  const creatorKey = await bootstrapCreatorKey(
    first,
    requirePresent(first.bootstrapSecret, 'the first start should print a bootstrap key')
  );
  const created = await createCheckoutGroup(first, creatorKey, 'restart-group');
  const createdBody = created.body as { group: { id: string; connection_id: string } };

  expectStatus(created, 201);

  await first.stop();

  const second = await startHivemindAfterTest({
    port: 0,
    dataDir: directory,
    responseKey: testResponseKey,
  });
  const again = await createCheckoutGroup(second, creatorKey, 'restart-group-2', {
    name: 'Payments',
    goal: 'Record the second group after a restart.',
    budget: '80',
    instructions: 'Plan the payments work.',
  });
  const againBody = again.body as { group: { connection_id: string } };

  expectStatus(again, 201);
  expect(againBody.group.connection_id).toBe(createdBody.group.connection_id);
});
