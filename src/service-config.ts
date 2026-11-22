import { closedGroupRetentionMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';

const retentionFlag = '--closed-group-retention-days';

/**
 * Resolve how long a closed group is kept.
 *
 * <p>A flag wins, then `HIVEMIND_CLOSED_GROUP_RETENTION_DAYS`, then 90 days. The housekeeping
 * run reads the number this returns and does not choose again.
 */
export function closedGroupRetentionFrom(input: {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}): number {
  const flag = readRetentionFlag(input.args);

  if (flag !== undefined) return daysToMs(flag);

  const configured = input.env.HIVEMIND_CLOSED_GROUP_RETENTION_DAYS;

  if (configured === undefined || configured === '') return closedGroupRetentionMs;

  return daysToMs(configured);
}

function readRetentionFlag(args: readonly string[]): string | undefined {
  let found: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === retentionFlag) {
      const value = args[index + 1];

      if (value === undefined || value.startsWith('--')) missingFlag();
      if (found !== undefined) duplicateFlag();

      found = value;
      index += 1;
      continue;
    }

    if (!arg.startsWith(`${retentionFlag}=`)) continue;

    const value = arg.slice(retentionFlag.length + 1);

    if (value.length === 0) missingFlag();
    if (found !== undefined) duplicateFlag();

    found = value;
  }

  return found;
}

function daysToMs(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new HivemindError(
      'validation_failed',
      'Closed-group retention is a whole number of days.'
    );
  }

  const ms = Number(raw) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ms;

  if (!Number.isSafeInteger(ms) || Number.isNaN(new Date(cutoff).getTime())) {
    throw new HivemindError(
      'validation_failed',
      'Closed-group retention is a whole number of days.'
    );
  }

  return ms;
}

function missingFlag(): never {
  throw new HivemindError(
    'validation_failed',
    'Missing a value for --closed-group-retention-days.'
  );
}

function duplicateFlag(): never {
  throw new HivemindError(
    'validation_failed',
    '--closed-group-retention-days was given more than once.'
  );
}
