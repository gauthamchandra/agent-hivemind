import { expect, test } from 'bun:test';
import { closedGroupRetentionMs } from '@/domain/background-jobs.ts';
import { closedGroupRetentionFrom } from '@/service-config.ts';

const day = 24 * 60 * 60 * 1000;

test('an unset closed-group retention is 90 days', () => {
  expect(closedGroupRetentionFrom({ args: [], env: {} })).toBe(closedGroupRetentionMs);
  expect(
    closedGroupRetentionFrom({ args: [], env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '' } })
  ).toBe(closedGroupRetentionMs);
});

test('a retention flag overrides the configured value', () => {
  expect(
    closedGroupRetentionFrom({
      args: [],
      env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '30' },
    })
  ).toBe(30 * day);
  expect(
    closedGroupRetentionFrom({
      args: ['--closed-group-retention-days=10'],
      env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '30' },
    })
  ).toBe(10 * day);
  expect(
    closedGroupRetentionFrom({
      args: ['--closed-group-retention-days', '10'],
      env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '30' },
    })
  ).toBe(10 * day);
  expect(closedGroupRetentionFrom({ args: ['--closed-group-retention-days=90'], env: {} })).toBe(
    closedGroupRetentionMs
  );
});

test('a retention flag or setting that is not a usable day count is refused', () => {
  expect(() =>
    closedGroupRetentionFrom({ args: ['--closed-group-retention-days'], env: {} })
  ).toThrow('Missing a value for --closed-group-retention-days.');
  expect(() =>
    closedGroupRetentionFrom({ args: ['--closed-group-retention-days='], env: {} })
  ).toThrow('Missing a value for --closed-group-retention-days.');
  expect(() =>
    closedGroupRetentionFrom({
      args: ['--closed-group-retention-days=10', '--closed-group-retention-days', '30'],
      env: {},
    })
  ).toThrow('--closed-group-retention-days was given more than once.');
  expect(() =>
    closedGroupRetentionFrom({ args: ['--closed-group-retention-days=10d'], env: {} })
  ).toThrow('Closed-group retention is a whole number of days.');
  expect(() =>
    closedGroupRetentionFrom({
      args: [],
      env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '10d' },
    })
  ).toThrow('Closed-group retention is a whole number of days.');
  expect(() =>
    closedGroupRetentionFrom({ args: ['--closed-group-retention-days=104000000'], env: {} })
  ).toThrow('Closed-group retention is a whole number of days.');
  expect(() =>
    closedGroupRetentionFrom({
      args: [],
      env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '104000000' },
    })
  ).toThrow('Closed-group retention is a whole number of days.');
});

test('a valid retention flag overrides an invalid setting', () => {
  expect(
    closedGroupRetentionFrom({
      args: ['--closed-group-retention-days=10'],
      env: { HIVEMIND_CLOSED_GROUP_RETENTION_DAYS: '10d' },
    })
  ).toBe(10 * day);
});
