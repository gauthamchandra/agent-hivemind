import { expect, test } from 'bun:test';
import { recordIntent, takeJob } from '@/core/supervision-run.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { leaseMs, leaseRenewMs } from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService } from '@/testing/boot.ts';
import type { TestDeps } from '@/testing/deps.ts';

const shortIntervalMs = 60 * 1000;

test('takeJob gives one worker the lease until both the interval and the expiry have passed', async () => {
  const { deps } = await bootService();

  expect(await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs)).toBe(1);
  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBeNull();

  deps.clock.advance(shortIntervalMs);

  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBeNull();

  deps.clock.advance(leaseMs - shortIntervalMs);

  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBe(2);
});

test('a write extends the lease only while its epoch still matches', async () => {
  const { deps } = await bootService();
  const epoch = requirePresent(
    await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs),
    'the lease should be free'
  );

  deps.clock.advance(leaseMs - leaseRenewMs / 2);

  expect(await holdLease(deps, epoch)).toBe(true);

  deps.clock.advance(leaseRenewMs);

  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBeNull();
  expect(await holdLease(deps, epoch + 1)).toBe(false);
});

test('a second intent for the same action returns the open one', async () => {
  const { deps } = await bootService();
  const epoch = requirePresent(
    await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs),
    'the lease should be free'
  );
  const options = { workerId: 'worker-a' };

  const first = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'end',
    'ses_a',
    defaultWorkspaceId
  );
  const second = await recordIntent(
    deps,
    options,
    'reaper',
    epoch,
    'end',
    'ses_a',
    defaultWorkspaceId
  );

  expect(second).toBe(first);
  expect(await deps.store.transact(tx => tx.openIntents('reaper'))).toHaveLength(1);
});

test('an intent from a stale epoch is refused', async () => {
  const { deps } = await bootService();
  const epoch = requirePresent(
    await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs),
    'the lease should be free'
  );

  await expect(
    recordIntent(
      deps,
      { workerId: 'worker-a' },
      'reaper',
      epoch + 1,
      'end',
      'ses_a',
      defaultWorkspaceId
    )
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await deps.store.transact(tx => tx.openIntents('reaper'))).toHaveLength(0);
});

function holdLease(deps: TestDeps, epoch: number): Promise<boolean> {
  return deps.store.transact(tx => tx.holdLease('reaper', epoch, formatTime(deps.clock.now())));
}
