export type Io = {
  args: string[];
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

export type Parsed = {
  positionals: string[];
  flags: Map<string, string>;
  json: boolean;
};

export function print(
  io: Io,
  body: Record<string, unknown>,
  asJson: boolean,
  text: string
): number {
  io.stdout(asJson ? JSON.stringify(body) : text);

  return 0;
}

function requireRow(value: unknown): Record<string, unknown> {
  if (!isRow(value)) {
    throw new CliError('unavailable', 'The service response was incomplete.');
  }

  return value;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function describe(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.role === 'string' && typeof body.group_name === 'string') {
    return `${body.role} on ${String(body.task_id)} in ${body.group_name}`;
  }

  if (Array.isArray(body.events)) {
    return body.events
      .map(event => {
        const row = requireRow(event);

        return `${text(row.sequence)} ${text(row.kind)} ${text(row.note)}`.trim();
      })
      .join('\n');
  }

  if (Array.isArray(body.tasks)) {
    return body.tasks
      .map(task => {
        const row = requireRow(task);

        return `${text(row.id)} ${text(row.state)} ${text(row.title)}`.trim();
      })
      .join('\n');
  }

  if (typeof body.task === 'object' && body.task !== null) {
    const task = body.task as { state?: string; title?: string; version?: number };

    return `${task.state ?? ''} ${task.title ?? ''} version ${task.version ?? ''}`.trim();
  }

  if (Array.isArray(body.sessions)) {
    return body.sessions
      .map(session => {
        const row = requireRow(session);

        return `${text(row.id)} ${text(row.role)} ${text(row.life)} ${text(row.title)}`.trim();
      })
      .join('\n');
  }

  return fallback;
}

const textOptions = new Set([
  'title',
  'description',
  'note',
  'instructions',
  'reason',
  'evidence-text',
]);

export function parseArgs(args: string[]): {
  positionals: string[];
  flags: Map<string, string>;
  json: boolean;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=', 2);

      if (equals !== -1) {
        const name = arg.slice(2, equals);
        const value = arg.slice(equals + 1);

        if (name.length === 0 || value.length === 0) {
          throw new CliError('validation_failed', `Missing a value for --${name}.`);
        }

        flags.set(name, value);
        continue;
      }

      const name = arg.slice(2);
      const value = args[index + 1];

      if (value === undefined || (value.startsWith('--') && !textOptions.has(name))) {
        throw new CliError('validation_failed', `Missing a value for ${arg}.`);
      }

      flags.set(name, value);
      index += 1;
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags, json };
}

export function flag(parsed: { flags: Map<string, string> }, name: string): string {
  const value = parsed.flags.get(name);

  if (value === undefined || value.length === 0) {
    throw new CliError('validation_failed', `Missing --${name}.`);
  }

  return value;
}

export function optional(parsed: { flags: Map<string, string> }, name: string): string | undefined {
  return parsed.flags.get(name);
}

export function errorCode(body: Record<string, unknown>): string {
  const error = body.error;

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return 'unavailable';
}

export function sentence(body: Record<string, unknown>): string {
  const error = body.error;

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }

  return 'The service rejected the command.';
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);

  return '';
}

export function readField(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== 'string')
    throw new CliError('unavailable', 'The service response was incomplete.');

  return value;
}

export class CliError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;

    if (hint !== undefined) this.hint = hint;
  }
}

export function exitCode(code: string): number {
  const codes: Record<string, number> = {
    unauthenticated: 1,
    policy_denied: 2,
    session_not_active: 3,
    cap_reached: 4,
    invalid_transition: 5,
    evidence_required: 6,
    conflict: 7,
    start_pending: 8,
    not_found: 9,
    validation_failed: 10,
    unavailable: 11,
    platform_unavailable: 11,
    token_unreadable: 13,
    rate_limited: 14,
    recipient_not_available: 15,
  };

  return codes[code] ?? 12;
}
