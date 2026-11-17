import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { requirePresent } from '@/testing/assertions.ts';
import { createTemporaryDirectory } from '@/testing/files.ts';
import { expectStatus } from '@/testing/http.ts';
import { runAfterTest, runPendingTeardowns } from '@/testing/teardown.ts';
import { waitUntil } from '@/testing/wait.ts';

describe('requirePresent', () => {
  test('requirePresent_valueIsPresent_returnsTheValue', () => {
    expect(requirePresent('token', 'the token should exist')).toBe('token');
    expect(requirePresent(0, 'zero is a real value')).toBe(0);
  });

  test('requirePresent_valueIsNullOrUndefined_throwsTheMessage', () => {
    expect(() => requirePresent(null, 'the token should exist')).toThrow('the token should exist');
    expect(() => requirePresent(undefined, 'the prompt should exist')).toThrow(
      'the prompt should exist'
    );
  });
});

describe('expectStatus', () => {
  test('expectStatus_statusMatches_passes', () => {
    expectStatus({ status: 201, body: {} }, 201);
  });

  test('expectStatus_statusDiffers_failureShowsTheResponseBody', () => {
    expect(() => expectStatus({ status: 500, body: { error: 'the store is down' } }, 201)).toThrow(
      /the store is down/
    );
  });
});

describe('waitUntil', () => {
  test('waitUntil_valueAppearsLater_returnsIt', async () => {
    let calls = 0;

    const found = await waitUntil(() => {
      calls += 1;

      return calls === 3 ? 'ready' : undefined;
    }, 'the value');

    expect(found).toBe('ready');
    expect(calls).toBe(3);
  });

  test('waitUntil_valueNeverAppears_failsNamingWhatItWaitedFor', async () => {
    await expect(waitUntil(() => null, 'the enrollment prompt', { attempts: 3 })).rejects.toThrow(
      'Timed out waiting for the enrollment prompt.'
    );
  });
});

describe('teardown', () => {
  test('runPendingTeardowns_twoRegistered_runsLastRegisteredFirst', async () => {
    const order: string[] = [];

    runAfterTest(() => order.push('registered first'));
    runAfterTest(() => order.push('registered second'));

    await runPendingTeardowns();

    expect(order).toEqual(['registered second', 'registered first']);
  });

  test('runPendingTeardowns_someReject_runsTheRestAndReportsEveryFailure', async () => {
    const completed: string[] = [];

    runAfterTest(() => completed.push('registered first'));
    runAfterTest(() => Promise.reject(new Error('registered second failed')));
    runAfterTest(() => Promise.reject(new Error('registered third failed')));
    runAfterTest(() => completed.push('registered fourth'));

    const failure = await runPendingTeardowns().catch((error: unknown) => error);

    expect(completed).toEqual(['registered fourth', 'registered first']);
    expect(failure).toMatchObject({
      errors: [new Error('registered third failed'), new Error('registered second failed')],
    });
  });

  test('createTemporaryDirectory_teardownsRun_directoryIsGone', async () => {
    const directory = await createTemporaryDirectory('hivemind-helper-');

    expect((await stat(directory)).isDirectory()).toBe(true);

    await runPendingTeardowns();

    await expect(stat(directory)).rejects.toThrow();
  });
});
