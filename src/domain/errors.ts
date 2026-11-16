export const errorCodes = [
  'validation_failed',
  'conflict',
  'unauthenticated',
  'forbidden',
  'not_found',
  'policy_denied',
  'invalid_transition',
  'condition_not_met',
  'evidence_required',
  'children_open',
  'unavailable',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type ErrorDetails = Readonly<Record<string, string | number>>;

/** A refusal a caller can branch on. The code is stable; the sentence is for a person. */
export class HivemindError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'HivemindError';
    this.code = code;
    this.details = details;
  }
}
