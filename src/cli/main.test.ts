import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runHivemind } from '@/cli/main.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { openInstallation } from '@/core/installation.ts';
import { HivemindError } from '@/domain/errors.ts';
import { createIds } from '@/domain/ids.ts';
import { startHttp } from '@/http/server.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import { manualClock } from '@/ports/clock.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPgliteStore } from '@/storage/postgres/store.ts';

export type Cli = {
  server: { stop(): void };
  io: {
    env: Record<string, string | undefined>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };
  out: string[];
  err: string[];
  sessionId: string;
  code: string;
};

const databases: PGlite[] = [];

afterEach(async () => {
  const open = databases.splice(0);

  await Promise.all(open.map(db => db.close()));
});

export async function bootCli(): Promise<Cli> {
  const db = new PGlite();
  databases.push(db);
  await db.waitReady;
  const clock = manualClock(new Date('2026-11-16T00:00:00.000Z'));
  const store = openPgliteStore(db);
  const deps: ServiceDeps = {
    store,
    clock,
    random: systemRandom,
    ids: createIds(clock, systemRandom),
    responseKey: 'test-response-key',
  };

  await store.migrate();
  const installation = await openInstallation(deps);
  const connectionId = deps.ids.connection();
  const simulated = createSimulatedPlatform(connectionId);

  simulated.drop('secret_injection');

  const platforms: Platforms = {
    require(id) {
      if (id !== connectionId) {
        throw new HivemindError('not_found', 'No connection with that identifier exists.');
      }

      return { adapter: simulated.adapter, connection: simulated.connection() };
    },
  };
  const server = await startHttp({ deps, platforms, connectionId });
  const home = await mkdtemp(join(tmpdir(), 'hivemind-'));
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    env: {
      HIVEMIND_URL: server.url,
      HIVEMIND_HOME: home,
    } as Record<string, string | undefined>,
    stdout: (line: string) => {
      out.push(line);
    },
    stderr: (line: string) => {
      err.push(line);
    },
    fetch,
    sleep: async () => {},
  };
  const admin = await fetch(`${server.url}/v1/bootstrap/administrator`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${installation.bootstrapSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ display_name: 'Ada' }),
  });

  expect(admin.status).toBe(201);

  const keyResponse = await fetch(`${server.url}/v1/bootstrap/keys`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${installation.bootstrapSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'creator', role: 'creator' }),
  });
  const keyBody = (await keyResponse.json()) as { secret: string };
  const created = await fetch(`${server.url}/v1/groups`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${keyBody.secret}`,
      'content-type': 'application/json',
      'idempotency-key': 'cli-group',
    },
    body: JSON.stringify({
      name: 'Checkout',
      goal: 'Move tax calculation behind an interface.',
      budget: '100',
      instructions: 'Plan the work.',
    }),
  });
  const createdBody = (await created.json()) as { session: { id: string } };
  const prompt = simulated.prompts().find(text => text.includes(createdBody.session.id)) ?? '';
  const code = /Enrollment code: (enr_[A-Za-z0-9_-]+)/.exec(prompt)?.[1] ?? '';

  return { server, io, out, err, sessionId: createdBody.session.id, code };
}

export async function enrolledCli(): Promise<Cli> {
  const cli = await bootCli();

  expect(
    await runHivemind({
      ...cli.io,
      args: ['enroll', '--session', cli.sessionId, '--code', cli.code],
    })
  ).toBe(0);
  cli.out.length = 0;
  cli.err.length = 0;

  return cli;
}

export async function rootTask(cli: Cli): Promise<{ id: string; version: number }> {
  const listed = await runHivemind({ ...cli.io, args: ['task', 'list', '--json'] });

  expect(listed).toBe(0);

  const roots = JSON.parse(cli.out.join('\n')) as {
    tasks: { id: string; parent_id: string | null; version: number }[];
  };
  const root = roots.tasks.find(task => task.parent_id === null);

  expect(root).toBeDefined();
  cli.out.length = 0;

  return root ?? { id: '', version: 0 };
}

test('enroll stores the token', async () => {
  const cli = await bootCli();

  expect(
    await runHivemind({
      ...cli.io,
      args: ['enroll', '--session', cli.sessionId, '--code', cli.code],
    })
  ).toBe(0);
  expect(cli.out).toEqual(['Enrolled.']);
  expect(cli.err).toEqual([]);

  const stored = await readFile(join(cli.io.env.HIVEMIND_HOME ?? '', 'token'), 'utf8');

  expect(stored.startsWith('ses_')).toBe(true);

  cli.server.stop();
});
test('whoami json reports the planner', async () => {
  const cli = await enrolledCli();

  expect(await runHivemind({ ...cli.io, args: ['whoami', '--json'] })).toBe(0);

  const who = JSON.parse(cli.out.join('\n')) as { role: string };

  expect(who.role).toBe('planner');

  cli.server.stop();
});
test('task list includes the root', async () => {
  const cli = await enrolledCli();
  const root = await rootTask(cli);

  expect(root.id.startsWith('tsk_')).toBe(true);

  cli.server.stop();
});
test('task move reports the transition', async () => {
  const cli = await enrolledCli();
  const root = await rootTask(cli);

  expect(
    await runHivemind({
      ...cli.io,
      args: [
        'task',
        'move',
        '--task',
        root.id,
        '--to',
        'analyzing',
        '--version',
        String(root.version),
        '--note',
        'The plan is underway.',
      ],
    })
  ).toBe(0);
  expect(cli.out.join('\n')).toContain('Reported the transition.');
  expect(cli.err).toEqual([]);

  cli.server.stop();
});
test('task create adds a child', async () => {
  const cli = await enrolledCli();
  const root = await rootTask(cli);

  expect(
    await runHivemind({
      ...cli.io,
      args: [
        'task',
        'move',
        '--task',
        root.id,
        '--to',
        'analyzing',
        '--version',
        String(root.version),
        '--note',
        'The plan is underway.',
      ],
    })
  ).toBe(0);
  expect(
    await runHivemind({
      ...cli.io,
      args: [
        'task',
        'create',
        '--title',
        'Hide the tax rules',
        '--description',
        'Move the calculation.',
      ],
    })
  ).toBe(0);

  cli.out.length = 0;

  expect(await runHivemind({ ...cli.io, args: ['task', 'list', '--json'] })).toBe(0);

  const tasks = JSON.parse(cli.out.join('\n')) as {
    tasks: { parent_id: string | null }[];
  };

  expect(tasks.tasks.some(task => task.parent_id !== null)).toBe(true);

  cli.server.stop();
});
test('member start adds a challenger', async () => {
  const cli = await enrolledCli();
  const root = await rootTask(cli);

  expect(
    await runHivemind({
      ...cli.io,
      args: [
        'member',
        'start',
        '--role',
        'challenger',
        '--task',
        root.id,
        '--instructions',
        'Read the plan.',
      ],
    })
  ).toBe(0);

  cli.out.length = 0;

  expect(await runHivemind({ ...cli.io, args: ['member', 'list', '--json'] })).toBe(0);

  const members = JSON.parse(cli.out.join('\n')) as { sessions: { role: string }[] };

  expect(members.sessions.map(session => session.role).sort()).toEqual(['challenger', 'planner']);

  cli.server.stop();
});
test('release and resume talk to the service', async () => {
  const cli = await enrolledCli();

  expect(await runHivemind({ ...cli.io, args: ['release'] })).toBe(0);
  expect(cli.out.join('\n')).toContain('Released the session.');

  cli.out.length = 0;

  expect(await runHivemind({ ...cli.io, args: ['resume'] })).toBe(0);
  expect(cli.out.join('\n')).toContain('Resumed the session.');

  cli.server.stop();
});
test('whoami without json prints the role', async () => {
  const cli = await enrolledCli();

  expect(await runHivemind({ ...cli.io, args: ['whoami'] })).toBe(0);
  expect(cli.out.join('\n')).toContain('planner');
  expect(cli.out.join('\n')).not.toBe('whoami');

  cli.server.stop();
});
test('a repeated enroll uses the same idempotency key', async () => {
  const keys: string[] = [];
  const io = {
    args: ['enroll', '--session', 'ses_member', '--code', 'enr_once'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9' },
    stdout: () => {},
    stderr: () => {},
    fetch: (async (_url: string, init?: { headers?: Record<string, string> }) => {
      keys.push(init?.headers?.['idempotency-key'] ?? '');

      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  };

  await runHivemind(io);
  await runHivemind(io);

  expect(keys[0]).toBe(keys[keys.length - 1]);
  expect(keys[0]?.includes('ses_member')).toBe(false);
  expect(keys[0]?.includes('enr_once')).toBe(false);
});
test('a later member start gets a new idempotency key', async () => {
  const keys: string[] = [];
  const io = {
    args: [
      'member',
      'start',
      '--role',
      'challenger',
      '--task',
      'tsk_one',
      '--instructions',
      'Read the plan.',
    ],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_secret_token' },
    stdout: () => {},
    stderr: () => {},
    fetch: (async (_url: string, init?: { headers?: Record<string, string> }) => {
      keys.push(init?.headers?.['idempotency-key'] ?? '');

      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  };

  await runHivemind(io);

  const first = keys[0] ?? '';

  expect(new Set(keys).size).toBe(1);

  keys.length = 0;
  await runHivemind(io);

  expect(keys[0]).not.toBe(first);
  expect(new Set(keys).size).toBe(1);
  expect(keys.join('').includes('ses_secret_token')).toBe(false);
});
test('an ipv6 loopback http address is a local endpoint', async () => {
  let fetched = false;
  const err: string[] = [];
  const code = await runHivemind({
    args: ['whoami', '--json'],
    env: { HIVEMIND_URL: 'http://[::1]:3000', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      fetched = true;

      return new Response(JSON.stringify({ role: 'planner' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(fetched).toBe(true);
  expect(code).toBe(0);
  expect(err).not.toContain('validation_failed');
});

test('an off-host http address is refused before the token is read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hivemind-http-'));
  let fetched = false;

  await mkdir(join(home, 'token'));

  const err: string[] = [];
  const code = await runHivemind({
    args: ['whoami'],
    env: { HIVEMIND_URL: 'http://example.com', HIVEMIND_HOME: home },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      fetched = true;

      throw new Error('the command should not call the service');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(10);
  expect(fetched).toBe(false);
  expect(err[0]).toBe('validation_failed');
  expect(err.join('\n')).toContain('https');
});

test('a title that starts with hyphens is sent as the title', async () => {
  let body = '';
  const code = await runHivemind({
    args: ['task', 'create', '--title', '--help crashes', '--description', 'Fix help output'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => {},
    stderr: () => {},
    fetch: (async (_url: string, init?: { body?: string | null }) => {
      body = init?.body ?? '';

      return new Response(
        JSON.stringify({ task: { state: 'planned', title: '--help crashes', version: 1 } }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(0);
  expect(body).toContain('"title":"--help crashes"');
});

test('a credential request rejects redirects', async () => {
  let redirect: string | undefined;
  const code = await runHivemind({
    args: ['whoami'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => {},
    stderr: () => {},
    fetch: (async (_url: string, init?: { redirect?: string }) => {
      redirect = init?.redirect;

      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(11);
  expect(redirect).toBe('error');
});

test('replacing an existing token file leaves it readable only by the owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hivemind-token-mode-'));
  const path = join(home, 'token');

  await writeFile(path, 'ses_old', { mode: 0o644 });
  await chmod(path, 0o644);

  const previous = await open(path, 'r');

  const code = await runHivemind({
    args: ['enroll', '--session', 'ses_member', '--code', 'enr_once'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_HOME: home },
    stdout: () => {},
    stderr: () => {},
    fetch: (async () =>
      new Response(JSON.stringify({ token: 'ses_new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    sleep: async () => {},
  });
  const mode = (await stat(path)).mode & 0o777;
  const stillThere = Buffer.alloc(7);

  await previous.read(stillThere, 0, 7, 0);
  await previous.close();

  expect(code).toBe(0);
  expect(stillThere.toString()).toBe('ses_old');
  expect(await readFile(path, 'utf8')).toBe('ses_new');
  expect(mode).toBe(0o600);
});

test('a text evidence note does not need a web address', async () => {
  let body = '';
  const code = await runHivemind({
    args: [
      'task',
      'move',
      '--task',
      'tsk_1',
      '--to',
      'analyzing',
      '--version',
      '1',
      '--note',
      'The checks passed.',
      '--evidence-text',
      'the suite passed',
    ],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => {},
    stderr: () => {},
    fetch: (async (_url: string, init?: { body?: string | null }) => {
      body = init?.body ?? '';

      return new Response(
        JSON.stringify({ task: { state: 'analyzing', title: 'Tax', version: 2 } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(0);
  expect(body).toContain('"kind":"text"');
  expect(body).toContain('the suite passed');
  expect(body).not.toContain('"kind":"address"');
});

test('task history asks the service for that task events', async () => {
  let path = '';
  const out: string[] = [];
  const code = await runHivemind({
    args: ['task', 'history', '--task', 'tsk_1', '--json'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: line => {
      out.push(line);
    },
    stderr: () => {},
    fetch: (async (url: string) => {
      path = url;

      return new Response(
        JSON.stringify({ events: [{ sequence: 1, kind: 'note', note: 'Cited from the work.' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(0);
  expect(path).toContain('/v1/tasks/tsk_1/events');
  expect(out.join('\n')).toContain('Cited from the work.');
});

test('task and member lists include the id', async () => {
  const out: string[] = [];
  const tasks = await runHivemind({
    args: ['task', 'list'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: line => {
      out.push(line);
    },
    stderr: () => {},
    fetch: (async () =>
      new Response(JSON.stringify({ tasks: [{ id: 'tsk_1', state: 'planned', title: 'Tax' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(tasks).toBe(0);
  expect(out.join('\n')).toContain('tsk_1');

  out.length = 0;

  const members = await runHivemind({
    args: ['member', 'list'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: line => {
      out.push(line);
    },
    stderr: () => {},
    fetch: (async () =>
      new Response(
        JSON.stringify({
          sessions: [{ id: 'ses_1', role: 'planner', life: 'live', title: 'Plan' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(members).toBe(0);
  expect(out.join('\n')).toContain('ses_1');
});

test('a flag without a value returns validation_failed', async () => {
  const err: string[] = [];
  const code = await runHivemind({
    args: ['task', 'show', '--task'],
    env: {},
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      throw new Error('the command should not call the service');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(10);
  expect(err[0]).toBe('validation_failed');
  expect(err.join('\n')).toContain('Missing a value for --task.');
});
test('a missing token says to enroll', async () => {
  const err: string[] = [];
  let fetches = 0;
  const home = await mkdtemp(join(tmpdir(), 'hivemind-notoken-'));
  const code = await runHivemind({
    args: ['whoami'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_HOME: home },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      fetches += 1;
      throw new Error('the command should not call the service');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(1);
  expect(err[0]).toBe('unauthenticated');
  expect(err.join('\n')).toContain('Enroll again, or ask for a new enrollment code.');
  expect(fetches).toBe(0);
});

test('a token file that cannot be read is not a network failure', async () => {
  const err: string[] = [];
  let fetches = 0;
  const home = await mkdtemp(join(tmpdir(), 'hivemind-token-dir-'));

  await mkdir(join(home, 'token'));

  const code = await runHivemind({
    args: ['whoami'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_HOME: home },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      fetches += 1;
      throw new Error('the command should not call the service');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).not.toBe(11);
  expect(err.join('\n')).toContain('The token file cannot be read.');
  expect(err.join('\n')).not.toContain('The service cannot be reached.');
  expect(fetches).toBe(0);
});
test('a token file that cannot be read is not a usage error', async () => {
  const err: string[] = [];
  const home = await mkdtemp(join(tmpdir(), 'hivemind-token-exit-'));

  await mkdir(join(home, 'token'));

  const unreadable = await runHivemind({
    args: ['whoami'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_HOME: home },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      throw new Error('the command should not call the service');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });
  const usage = await runHivemind({
    args: ['nope'],
    env: {},
    stdout: () => {},
    stderr: () => {},
    fetch: (async () => {
      throw new Error('the command should not call the service');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(usage).toBe(12);
  expect(unreadable).not.toBe(usage);
  expect(err[0]).toBe('token_unreadable');
});

test('a non-JSON error status is not retried', async () => {
  const err: string[] = [];
  let calls = 0;
  const code = await runHivemind({
    args: ['release'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      calls += 1;

      return new Response('bad gateway', { status: 502 });
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(calls).toBe(1);
  expect(code).not.toBe(11);
  expect(err.join('\n')).toContain('502');
  expect(err.join('\n')).not.toContain('The service cannot be reached.');
});

test('a response that is not an object is refused', async () => {
  for (const payload of ['null', '[]']) {
    let fetches = 0;
    const err: string[] = [];
    const code = await runHivemind({
      args: ['whoami'],
      env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
      stdout: () => {},
      stderr: line => {
        err.push(line);
      },
      fetch: (async () => {
        fetches += 1;

        return new Response(payload, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });

    expect(code).toBe(11);
    expect(fetches).toBe(1);
    expect(err.join('\n')).toContain('The service response was incomplete.');
    expect(err.join('\n')).not.toContain('The service cannot be reached.');
  }
});

test('a null or non-object list row is an incomplete response', async () => {
  const cases = [
    { args: ['task', 'history', '--task', 'tsk_1'], body: { events: [null] } },
    { args: ['task', 'list'], body: { tasks: [null] } },
    { args: ['member', 'list'], body: { sessions: [null] } },
    { args: ['task', 'history', '--task', 'tsk_1'], body: { events: ['note'] } },
  ];

  for (const item of cases) {
    let fetches = 0;
    const err: string[] = [];
    const code = await runHivemind({
      args: item.args,
      env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
      stdout: () => {},
      stderr: line => {
        err.push(line);
      },
      fetch: (async () => {
        fetches += 1;

        return new Response(JSON.stringify(item.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });

    expect(fetches).toBe(1);
    expect(code).toBe(11);
    expect(err.join('\n')).toContain('The service response was incomplete.');
    expect(err.join('\n')).not.toContain('The service cannot be reached.');
  }
});

test('a network failure says the service cannot be reached', async () => {
  const err: string[] = [];
  const code = await runHivemind({
    args: ['whoami'],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: () => {},
    stderr: line => {
      err.push(line);
    },
    fetch: (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(11);
  expect(err.join('\n')).toContain('The service cannot be reached.');
  expect(err.join('\n')).not.toContain('The service rejected the command.');
});
test('a pending member start exits with the start_pending code', async () => {
  const err: string[] = [];
  const out: string[] = [];
  const code = await runHivemind({
    args: [
      'member',
      'start',
      '--role',
      'implementer',
      '--task',
      'tsk',
      '--instructions',
      'Write it.',
    ],
    env: { HIVEMIND_URL: 'http://127.0.0.1:9', HIVEMIND_TOKEN: 'ses_token' },
    stdout: line => {
      out.push(line);
    },
    stderr: line => {
      err.push(line);
    },
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'start_pending',
            message: 'The platform did not say whether it started the session.',
            details: { session_id: 'ses_1' },
          },
        }),
        { status: 202, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch,
    sleep: async () => {},
  });

  expect(code).toBe(8);
  expect(err).toContain('start_pending');
  expect(out.join('\n')).not.toContain('Started the member.');
});
