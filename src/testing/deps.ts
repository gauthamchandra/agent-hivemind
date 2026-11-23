import type { PGlite } from '@electric-sql/pglite';
import type { ServiceDeps } from '@/core/deps.ts';
import { closedGroupRetentionMs } from '@/domain/background-jobs.ts';
import { createIds } from '@/domain/ids.ts';
import { type RandomSource, systemRandom } from '@/ports/random.ts';
import { openPgliteStore } from '@/storage/postgres/store.ts';
import { type ManualClock, manualClock } from '@/testing/clock.ts';

export const testStartTime = '2026-11-16T00:00:00.000Z';
export const testResponseKey = 'test-response-key';

export type TestDeps = ServiceDeps & { clock: ManualClock };

/**
 * Wire service dependencies around a test database with a clock the test can move.
 *
 * <p>The clock starts at {@link testStartTime}. Random bytes come from the system unless the
 * test passes a source, for example {@link fixedRandom} when it asserts a derived value.
 */
export function createTestDeps(
  db: PGlite,
  options?: { random?: RandomSource; start?: string }
): TestDeps {
  const random = options?.random ?? systemRandom;
  const clock = manualClock(new Date(options?.start ?? testStartTime));

  return {
    store: openPgliteStore(db),
    clock,
    random,
    ids: createIds(clock, random),
    responseKey: testResponseKey,
    closedGroupRetentionMs,
  };
}

export function fixedRandom(byte: number): RandomSource {
  return {
    bytes(length) {
      return new Uint8Array(length).fill(byte);
    },
  };
}
