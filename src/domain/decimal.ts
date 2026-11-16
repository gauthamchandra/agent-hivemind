import { HivemindError } from '@/domain/errors.ts';

const decimal = /^(\d{1,20})(?:\.(\d{1,20}))?$/;

/** Compare two non-negative decimal strings. Returns -1, 0, or 1. */
export function compareDecimal(left: string, right: string): number {
  const [leftWhole, leftFraction] = parts(left);
  const [rightWhole, rightFraction] = parts(right);
  const whole = compareInteger(leftWhole, rightWhole);

  if (whole !== 0) return whole;

  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, '0');
  const rightPadded = rightFraction.padEnd(width, '0');

  if (leftPadded === rightPadded) return 0;

  return leftPadded > rightPadded ? 1 : -1;
}

/** Normalize a decimal from a caller or from Postgres. */
export function canonicalizeDecimal(value: string): string {
  const match = decimal.exec(value.trim());

  if (match === null) {
    throw new HivemindError('validation_failed', 'The amount is not a decimal number.', {
      field: 'budget',
    });
  }

  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');

  if (fraction.length === 0) return normalizedWhole;

  return `${normalizedWhole}.${fraction}`;
}

export function requirePositiveDecimal(value: string): string {
  const canonical = canonicalizeDecimal(value);

  if (compareDecimal(canonical, '0') <= 0) {
    throw new HivemindError('validation_failed', 'The amount must be greater than zero.', {
      field: 'budget',
    });
  }

  return canonical;
}

function parts(value: string): [string, string] {
  const canonical = canonicalizeDecimal(value);
  const [whole, fraction = ''] = canonical.split('.');

  return [whole ?? '0', fraction];
}

function compareInteger(left: string, right: string): number {
  const a = left.replace(/^0+/, '') || '0';
  const b = right.replace(/^0+/, '') || '0';

  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a === b) return 0;

  return a > b ? 1 : -1;
}
