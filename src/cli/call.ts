import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, errorCode, type Io, sentence } from '@/cli/io.ts';

const waits = [1000, 2000, 4000, 8000, 16000];

export async function call(
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

      if (!isRecord(parsed)) {
        throw new CliError('unavailable', 'The service response was incomplete.');
      }

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
async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CliError(String(response.status), `The service returned ${response.status}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Enrollment must replay after a lost response. Other commands are a new attempt each run. */
export function requestKey(method: string, path: string, body: unknown): string {
  const payload = body === undefined ? '' : JSON.stringify(body);

  return createHash('sha256').update(`${method}\n${path}\n${payload}`).digest('hex');
}

export async function token(io: Io): Promise<string> {
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

export function baseUrl(io: Io): string {
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
