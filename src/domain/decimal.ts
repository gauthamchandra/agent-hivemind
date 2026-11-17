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

/** Turn a finite nonnegative number into a canonical decimal string. */
export function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new HivemindError('validation_failed', 'The amount is not a decimal number.', {
      field: 'budget',
    });
  }

  return canonicalizeDecimal(plainDecimal(value.toString()));
}

/** Add two non-negative decimal strings and return the canonical sum. */
export function addDecimal(left: string, right: string): string {
  const width = Math.max(parts(left)[1].length, parts(right)[1].length);

  return fromScaled(toScaled(left, width) + toScaled(right, width), width);
}

/** Subtract a non-negative decimal from another. A negative result is zero. */
export function subtractDecimal(left: string, right: string): string {
  const width = Math.max(parts(left)[1].length, parts(right)[1].length);
  const difference = toScaled(left, width) - toScaled(right, width);

  if (difference <= 0n) return '0';

  return fromScaled(difference, width);
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

function toScaled(value: string, width: number): bigint {
  const [whole, fraction] = parts(value);
  const padded = fraction.padEnd(width, '0');

  return BigInt(whole) * 10n ** BigInt(width) + BigInt(padded === '' ? '0' : padded);
}

function fromScaled(amount: bigint, width: number): string {
  const text = scaledText(amount, width);

  if (decimal.test(text) !== true) {
    throw new HivemindError('validation_failed', 'The amount is too large.', {
      field: 'budget',
    });
  }

  return text;
}

function scaledText(amount: bigint, width: number): string {
  if (width === 0) return amount.toString();

  const scale = 10n ** BigInt(width);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(width, '0').replace(/0+$/, '');

  if (fraction.length === 0) return whole.toString();

  return `${whole}.${fraction}`;
}

function plainDecimal(text: string): string {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);

  if (match === null || match[3] === undefined) return text;

  const fraction = match[2] ?? '';
  const digits = `${match[1] ?? '0'}${fraction}`.replace(/^0+/, '') || '0';
  const shift = Number(match[3]) - fraction.length;

  if (shift >= 0) return `${digits}${'0'.repeat(shift)}`;

  const places = -shift;

  if (places >= digits.length) return `0.${'0'.repeat(places - digits.length)}${digits}`;

  return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
}

function compareInteger(left: string, right: string): number {
  const a = left.replace(/^0+/, '') || '0';
  const b = right.replace(/^0+/, '') || '0';

  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a === b) return 0;

  return a > b ? 1 : -1;
}
