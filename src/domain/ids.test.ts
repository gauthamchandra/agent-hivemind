import { describe, expect, test } from 'bun:test';
import { createIds } from '@/domain/ids.ts';
import { manualClock } from '@/ports/clock.ts';
import type { RandomSource } from '@/ports/random.ts';

const fixedRandom: RandomSource = {
  bytes(length) {
    return new Uint8Array(length).fill(7);
  },
};

describe('identifiers', () => {
  test('mints a prefixed sortable id and keeps order inside one millisecond', () => {
    const clock = manualClock(new Date('2026-11-16T00:00:00.000Z'));
    const ids = createIds(clock, fixedRandom);
    const first = ids.group();
    const second = ids.group();

    expect(first).toMatch(/^grp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toMatch(/^grp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first < second).toBe(true);
  });

  test('sorts a later instant after an earlier one', () => {
    const clock = manualClock(new Date('2026-11-16T00:00:00.000Z'));
    const ids = createIds(clock, fixedRandom);
    const earlier = ids.task();

    clock.advance(1);

    const later = ids.task();

    expect(earlier < later).toBe(true);
  });
});
