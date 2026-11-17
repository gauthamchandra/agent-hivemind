import { HivemindError } from '@/domain/errors.ts';

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Format an instant as UTC RFC 3339 with milliseconds. */
export function formatTime(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new HivemindError('validation_failed', 'The time is not a real instant.');
  }

  return instant.toISOString();
}

/** Read a UTC timestamp with milliseconds. */
export function parseTime(value: string): Date {
  if (!timestamp.test(value)) {
    throw new HivemindError('validation_failed', 'Times are UTC timestamps with milliseconds.');
  }

  const instant = new Date(value);

  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
    throw new HivemindError('validation_failed', 'Times are UTC timestamps with milliseconds.');
  }

  return instant;
}

/** Accept a timestamp from Postgres, which may arrive as a Date or as text. */
export function readTime(value: unknown): string {
  if (value instanceof Date) return formatTime(value);

  if (typeof value === 'string') {
    const instant = new Date(value);

    if (!Number.isNaN(instant.getTime())) return formatTime(instant);
  }

  throw new HivemindError('unavailable', 'The database returned a time the service cannot read.');
}
