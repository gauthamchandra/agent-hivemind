export const capabilities = [
  'secret_injection',
  'on_behalf_of',
  'list_by_tag',
  'wake_on_message',
  'usage_reading',
  'usage_ceiling',
  'idempotent_start',
  'message_while_working',
  'status_events',
] as const;

export type Capability = (typeof capabilities)[number];

export const platformErrorClasses = [
  'auth',
  'rate_limited',
  'quota',
  'invalid',
  'not_found',
  'unavailable',
] as const;

export type PlatformErrorClass = (typeof platformErrorClasses)[number];

export const sendResults = ['accepted', 'busy', 'rate_limited', 'gone'] as const;
export type SendResult = (typeof sendResults)[number];

/** A platform failure. The message never includes a credential, a prompt, or a message body. */
export class PlatformError extends Error {
  readonly errorClass: PlatformErrorClass;
  readonly retryAfterSeconds: number | null;

  constructor(
    errorClass: PlatformErrorClass,
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'PlatformError';
    this.errorClass = errorClass;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isRefusal(errorClass: PlatformErrorClass): boolean {
  return (
    errorClass === 'auth' ||
    errorClass === 'invalid' ||
    errorClass === 'quota' ||
    errorClass === 'rate_limited'
  );
}
