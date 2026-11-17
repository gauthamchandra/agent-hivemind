import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Io = {
  args: string[];
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

const waits = [1000, 2000, 4000, 8000, 16000];

const instructions: Record<string, string> = {
  cap_reached: 'Do not retry. Tell the planner which cap was reached, or escalate.',
  policy_denied: 'Your role cannot do this. Ask the member whose role can.',
  unauthenticated: 'Enroll again, or ask for a new enrollment code.',
  token_unreadable: 'The token file cannot be read. Fix that file, or enroll again.',
  session_not_active: 'This session cannot do that from its current life.',
  invalid_transition:
    'Read the task and report a transition your role can make from its current state.',
  evidence_required: 'Add the evidence this transition asks for, then report it again.',
  conflict: 'Read the task again and report with the current version.',
  start_pending: 'The start is still pending. Read the session before you try again.',
};

/** Run one hivemind command. The token stays in a file and is never printed. */
export async function runHivemind(io: Io): Promise<number> {
  try {
    const parsed = parseArgs(io.args);
    const [group, command] = parsed.positionals;

    if (group === 'enroll') {
      const session = flag(parsed, 'session');
      const code = flag(parsed, 'code');
      const response = await call(
        io,
        'POST',
        '/v1/session/enroll',
        { session_id: session, code },
        false
      );
      const token = readField(response, 'token');
      const home = io.env.HIVEMIND_HOME ?? join(homedir(), '.hivemind');

      const tokenPath = join(home, 'token');
      const staging = `${tokenPath}.${randomUUID()}.tmp`;

      await mkdir(home, { recursive: true });
      await writeFile(staging, token, { mode: 0o600, flag: 'wx' });

      try {
        await rename(staging, tokenPath);
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
      io.stdout('Enrolled.');

      return 0;
    }

    if (group === 'whoami') {
      const body = await call(io, 'GET', '/v1/session', undefined, true);

      return print(io, body, parsed.json, describe(body, 'whoami'));
    }
    if (group === 'task' && command === 'list') {
      const body = await call(io, 'GET', '/v1/tasks', undefined, true);

      return print(io, body, parsed.json, describe(body, 'tasks'));
    }
    if (group === 'task' && command === 'history') {
      const body = await call(
        io,
        'GET',
        `/v1/tasks/${flag(parsed, 'task')}/events`,
        undefined,
        true
      );

      return print(io, body, parsed.json, describe(body, 'history'));
    }
    if (group === 'task' && command === 'show') {
      const body = await call(io, 'GET', `/v1/tasks/${flag(parsed, 'task')}`, undefined, true);

      return print(io, body, parsed.json, describe(body, 'task'));
    }
    if (group === 'task' && command === 'create') {
      return print(
        io,
        await call(
          io,
          'POST',
          '/v1/tasks',
          { title: flag(parsed, 'title'), description: flag(parsed, 'description') },
          true
        ),
        parsed.json,
        'Created the task.'
      );
    }
    if (group === 'task' && command === 'edit') {
      return print(
        io,
        await call(
          io,
          'PATCH',
          `/v1/tasks/${flag(parsed, 'task')}`,
          { title: optional(parsed, 'title'), description: optional(parsed, 'description') },
          true
        ),
        parsed.json,
        'Edited the task.'
      );
    }
    if (group === 'task' && (command === 'move' || command === 'fail')) {
      const evidenceUrl = optional(parsed, 'evidence-url');
      const evidenceText = optional(parsed, 'evidence-text');
      const evidence = [
        ...(evidenceUrl === undefined
          ? []
          : [{ label: 'evidence', kind: 'address' as const, value: evidenceUrl }]),
        ...(evidenceText === undefined
          ? []
          : [{ label: 'evidence', kind: 'text' as const, value: evidenceText }]),
      ];

      return print(
        io,
        await call(
          io,
          'POST',
          `/v1/tasks/${flag(parsed, 'task')}/transitions`,
          {
            to: command === 'fail' ? 'failed' : flag(parsed, 'to'),
            expected_version: Number(flag(parsed, 'version')),
            note: flag(parsed, 'note'),
            evidence,
          },
          true
        ),
        parsed.json,
        'Reported the transition.'
      );
    }
    if (group === 'task' && command === 'note') {
      return print(
        io,
        await call(
          io,
          'POST',
          `/v1/tasks/${flag(parsed, 'task')}/notes`,
          { note: flag(parsed, 'note'), evidence: [] },
          true
        ),
        parsed.json,
        'Added the note.'
      );
    }
    if (group === 'member' && command === 'list') {
      const body = await call(io, 'GET', '/v1/sessions', undefined, true);

      return print(io, body, parsed.json, describe(body, 'members'));
    }
    if (group === 'member' && command === 'start') {
      return print(
        io,
        await call(
          io,
          'POST',
          '/v1/sessions',
          {
            role: flag(parsed, 'role'),
            task_id: flag(parsed, 'task'),
            instructions: flag(parsed, 'instructions'),
          },
          true
        ),
        parsed.json,
        'Started the member.'
      );
    }
    if (group === 'member' && command === 'replace') {
      return print(
        io,
        await call(
          io,
          'POST',
          `/v1/sessions/${flag(parsed, 'session')}/replace`,
          { instructions: flag(parsed, 'instructions') },
          true
        ),
        parsed.json,
        'Started the replacement.'
      );
    }
    if (group === 'release') {
      return print(
        io,
        await call(io, 'POST', '/v1/session/release', {}, true),
        parsed.json,
        'Released the session.'
      );
    }
    if (group === 'resume') {
      return print(
        io,
        await call(io, 'POST', '/v1/session/resume', {}, true),
        parsed.json,
        'Resumed the session.'
      );
    }
    if (group === 'member' && command === 'end') {
      return print(
        io,
        await call(
          io,
          'POST',
          `/v1/sessions/${flag(parsed, 'session')}/end`,
          { reason: flag(parsed, 'reason') },
          true
        ),
        parsed.json,
        'Ended the member.'
      );
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(error.code);
      io.stderr(error.message);
      io.stderr(
        instructions[error.code] ?? 'Stop and say what failed in your own platform session.'
      );

      return exitCode(error.code);
    }

    io.stderr('unavailable');
    io.stderr(error instanceof Error ? error.message : 'The service cannot be reached.');
    io.stderr('Stop. Say in your own platform session that the service cannot be reached.');

    return 11;
  }

  io.stderr('Run hivemind enroll, whoami, task, member, release, or resume.');

  return 12;
}

async function call(
  io: Io,
  method: string,
  path: string,
  body: unknown,
  authenticated: boolean
): Promise<Record<string, unknown>> {
  const key = path === '/v1/session/enroll' ? requestKey(method, path, body) : randomUUID();
  let last: { status: number; body: Record<string, unknown> } | null = null;

  for (let attempt = 0; attempt < waits.length + 1; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': key,
      };

      const root = baseUrl(io);

      if (authenticated) headers.authorization = `Bearer ${await token(io)}`;

      const response = await io.fetch(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        redirect: 'error',
      });
      const parsed = await readBody(response);

      last = { status: response.status, body: parsed };
      const code = errorCode(parsed);

      if (response.status === 202 || code === 'start_pending') {
        throw new CliError(code === 'start_pending' ? code : 'start_pending', sentence(parsed));
      }

      if (response.ok) return parsed;

      if (code !== 'unavailable' && code !== 'platform_unavailable') {
        throw new CliError(code, sentence(parsed));
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      last = null;
    }

    const wait = waits[attempt];

    if (wait === undefined) break;

    await io.sleep(wait);
  }

  if (last === null) throw new CliError('unavailable', 'The service cannot be reached.');

  throw new CliError('unavailable', sentence(last.body));
}

/** A received body that is not JSON is that response, not a lost connection. */
async function readBody(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw new CliError(String(response.status), `The service returned ${response.status}.`);
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(String(response.status), `The service returned ${response.status}.`);
  }

  return value as Record<string, unknown>;
}

/** Enrollment must replay after a lost response. Other commands are a new attempt each run. */
function requestKey(method: string, path: string, body: unknown): string {
  const payload = body === undefined ? '' : JSON.stringify(body);

  return createHash('sha256').update(`${method}\n${path}\n${payload}`).digest('hex');
}

async function token(io: Io): Promise<string> {
  if (io.env.HIVEMIND_TOKEN) return io.env.HIVEMIND_TOKEN;

  const home = io.env.HIVEMIND_HOME ?? join(homedir(), '.hivemind');

  try {
    return (await readFile(join(home, 'token'), 'utf8')).trim();
  } catch (error) {
    if (isMissingFile(error)) {
      throw new CliError('unauthenticated', 'Enroll before running this command.');
    }

    throw new CliError('token_unreadable', 'The token file cannot be read.');
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function baseUrl(io: Io): string {
  const url = io.env.HIVEMIND_URL;

  if (url === undefined || url.length === 0) {
    throw new CliError('validation_failed', 'HIVEMIND_URL is not set.');
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new CliError('validation_failed', 'HIVEMIND_URL is not a URL.');
  }

  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new CliError('validation_failed', 'HIVEMIND_URL must use https off this machine.');
  }

  return url.replace(/\/$/, '');
}

function print(io: Io, body: Record<string, unknown>, asJson: boolean, text: string): number {
  io.stdout(asJson ? JSON.stringify(body) : text);

  return 0;
}

function describe(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.role === 'string' && typeof body.group_name === 'string') {
    return `${body.role} on ${String(body.task_id)} in ${body.group_name}`;
  }

  if (Array.isArray(body.events)) {
    return body.events
      .map(event => {
        const row = event as { sequence?: number; kind?: string; note?: string | null };

        return `${row.sequence ?? ''} ${row.kind ?? ''} ${row.note ?? ''}`.trim();
      })
      .join('\n');
  }

  if (Array.isArray(body.tasks)) {
    return body.tasks
      .map(task => {
        const row = task as { id?: string; state?: string; title?: string };

        return `${row.id ?? ''} ${row.state ?? ''} ${row.title ?? ''}`.trim();
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
        const row = session as { id?: string; role?: string; life?: string; title?: string };

        return `${row.id ?? ''} ${row.role ?? ''} ${row.life ?? ''} ${row.title ?? ''}`.trim();
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

function parseArgs(args: string[]): {
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

function flag(parsed: { flags: Map<string, string> }, name: string): string {
  const value = parsed.flags.get(name);

  if (value === undefined || value.length === 0) {
    throw new CliError('validation_failed', `Missing --${name}.`);
  }

  return value;
}

function optional(parsed: { flags: Map<string, string> }, name: string): string | undefined {
  return parsed.flags.get(name);
}

function errorCode(body: Record<string, unknown>): string {
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

function sentence(body: Record<string, unknown>): string {
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

function readField(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== 'string')
    throw new CliError('unavailable', 'The service response was incomplete.');

  return value;
}

class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function exitCode(code: string): number {
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
  };

  return codes[code] ?? 12;
}

if (import.meta.main) {
  const code = await runHivemind({
    args: process.argv.slice(2),
    env: process.env,
    stdout: line => console.log(line),
    stderr: line => console.error(line),
    fetch,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });

  process.exit(code);
}
