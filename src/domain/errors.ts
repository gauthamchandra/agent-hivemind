export const errorCodes = [
  'validation_failed',
  'conflict',
  'unauthenticated',
  'forbidden',
  'not_found',
  'policy_denied',
  'session_not_active',
  'invalid_transition',
  'condition_not_met',
  'evidence_required',
  'children_open',
  'cap_reached',
  'start_pending',
  'ambiguous_credentials',
  'idempotency_conflict',
  'request_in_progress',
  'payload_too_large',
  'capability_missing',
  'platform_rate_limited',
  'platform_quota',
  'platform_unavailable',
  'platform_auth_failed',
  'group_closed',
  'unavailable',
  'recipient_not_available',
  'rate_limited',
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
