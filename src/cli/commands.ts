import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, hivemindHome } from '@/cli/call.ts';
import { describe, flag, type Io, optional, type Parsed, print, readField } from '@/cli/io.ts';

export async function enrollCommand(io: Io, parsed: Parsed): Promise<number | null> {
  const [group, _command] = parsed.positionals;
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
    const home = hivemindHome(io);

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
  return null;
}

export async function whoamiCommand(io: Io, parsed: Parsed): Promise<number | null> {
  const [group, _command] = parsed.positionals;
  if (group === 'whoami') {
    const body = await call(io, 'GET', '/v1/session', undefined, true);

    return print(io, body, parsed.json, describe(body, 'whoami'));
  }
  return null;
}

export async function taskCommand(io: Io, parsed: Parsed): Promise<number | null> {
  const [group, command] = parsed.positionals;
  if (group === 'task' && command === 'list') {
    const body = await call(io, 'GET', '/v1/tasks', undefined, true);

    return print(io, body, parsed.json, describe(body, 'tasks'));
  }
  if (group === 'task' && command === 'history') {
    const body = await call(io, 'GET', `/v1/tasks/${flag(parsed, 'task')}/events`, undefined, true);

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
  return null;
}

export async function releaseCommand(io: Io, parsed: Parsed): Promise<number | null> {
  const [group] = parsed.positionals;

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

  return null;
}

export async function memberCommand(io: Io, parsed: Parsed): Promise<number | null> {
  const [group, command] = parsed.positionals;
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
  return null;
}
