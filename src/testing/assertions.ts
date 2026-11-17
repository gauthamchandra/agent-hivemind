import { expect } from 'bun:test';
import { type ErrorCode, HivemindError } from '@/domain/errors.ts';

/**
 * Return the value, or fail the test with the message when it is missing.
 *
 * <p>Use this instead of {@code value ?? ''} or a non-null assertion. A fallback turns a missing
 * value into an empty string and lets later assertions pass for the wrong reason.
 */
export function requirePresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);

  return value;
}

export async function expectHivemindError(
  work: Promise<unknown>,
  code: ErrorCode
): Promise<HivemindError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(HivemindError);
    if (!(error instanceof HivemindError)) throw error;

    expect(error.code).toBe(code);
    return error;
  }

  throw new Error(`expected ${code}`);
}
