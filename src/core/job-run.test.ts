import { expect, test } from 'bun:test';
import { type JobRunResult, recordPlannedAction, takeJob } from '@/core/job-run.ts';
import { jobLockCheckMs, jobLockMs } from '@/domain/background-jobs.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService } from '@/testing/boot.ts';
import type { TestDeps } from '@/testing/deps.ts';

const shortIntervalMs = 60 * 1000;

test('takeJob gives one worker the job lock until both the interval and the expiry have passed', async () => {
  const { deps } = await bootService();

  expect(await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs)).toBe(1);
  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBeNull();

  deps.clock.advance(shortIntervalMs);

  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBeNull();

  deps.clock.advance(jobLockMs - shortIntervalMs);

  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBe(2);
});

test('a write extends the job lock only while its lock id still matches', async () => {
  const { deps } = await bootService();
  const lockId = requirePresent(
    await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs),
    'the job lock should be free'
  );

  deps.clock.advance(jobLockMs - jobLockCheckMs / 2);

  expect(await holdJobLock(deps, lockId)).toBe(true);

  deps.clock.advance(jobLockCheckMs);

  expect(await takeJob(deps, 'reaper', 'worker-b', shortIntervalMs)).toBeNull();
  expect(await holdJobLock(deps, lockId + 1)).toBe(false);
});

test('a second planned action for the same action returns the open one', async () => {
  const { deps } = await bootService();
  const lockId = requirePresent(
    await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs),
    'the job lock should be free'
  );
  const options = { workerId: 'worker-a' };

  const first = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
    'end',
    'ses_a',
    defaultWorkspaceId
  );
  const second = await recordPlannedAction(
    deps,
    options,
    'reaper',
    lockId,
    'end',
    'ses_a',
    defaultWorkspaceId
  );

  expect(second).toBe(first);
  expect(await deps.store.transact(tx => tx.openPlannedActions('reaper'))).toHaveLength(1);
});

test('a planned action from an old lock id is refused', async () => {
  const { deps } = await bootService();
  const lockId = requirePresent(
    await takeJob(deps, 'reaper', 'worker-a', shortIntervalMs),
    'the job lock should be free'
  );

  await expect(
    recordPlannedAction(
      deps,
      { workerId: 'worker-a' },
      'reaper',
      lockId + 1,
      'end',
      'ses_a',
      defaultWorkspaceId
    )
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await deps.store.transact(tx => tx.openPlannedActions('reaper'))).toHaveLength(0);
});

test('a job run that ran always carries its lock id and one that did not carries none', () => {
  const ran: JobRunResult = { ran: true, lockId: 3 };
  const skipped: JobRunResult = { ran: false, lockId: null };
  // @ts-expect-error a run that ran must say which lock id it ran under
  const ranWithoutLockId: JobRunResult = { ran: true, lockId: null };
  // @ts-expect-error a run that did not run holds no lock id
  const skippedWithLockId: JobRunResult = { ran: false, lockId: 3 };

  expect([ran.lockId, skipped.lockId]).toEqual([3, null]);
  expect([ranWithoutLockId.ran, skippedWithLockId.ran]).toEqual([true, false]);
});

function holdJobLock(deps: TestDeps, lockId: number): Promise<boolean> {
  return deps.store.transact(tx => tx.holdJobLock('reaper', lockId, formatTime(deps.clock.now())));
}
