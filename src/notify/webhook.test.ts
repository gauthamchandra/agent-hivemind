import { expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { toNotification } from '@/core/alert-notify.ts';
import type { AlertRecord, AlertRule } from '@/domain/background-jobs.ts';
import { alertRules } from '@/domain/background-jobs.ts';
import { defaultWorkspaceId, requireAlertId } from '@/domain/ids.ts';
import {
  createWebhookNotifier,
  webhookNotifierFromEnv,
  webhookSignature,
} from '@/notify/webhook.ts';
import type { Notification } from '@/ports/notifier.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { createTemporaryDirectory } from '@/testing/files.ts';
import { runAfterTest } from '@/testing/teardown.ts';

const secret = randomBytes(16).toString('hex');
const hookUrl = 'https://hooks.example.com/workflows/T0123/A0456/9876543210';
const sentAt = '2026-11-19T10:00:00.000Z';

type Credentials = { certificate: string; key: string };

let generated: Promise<Credentials> | undefined;

// The https tests make their own certificate when they run, for hooks.example.test and
// untrusted.example.test, so that no key is committed. The names do not resolve, so a request that
// reaches the server went to the address that was pinned. Each test uses its own name, because Bun
// keeps a TLS context per name.
function testCredentials(): Promise<Credentials> {
  generated ??= makeCredentials();

  return generated;
}

async function makeCredentials(): Promise<Credentials> {
  const directory = await createTemporaryDirectory('hivemind-webhook-');
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  const openssl = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=hooks.example.test',
      '-addext',
      'subjectAltName=DNS:hooks.example.test,DNS:untrusted.example.test',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdout: 'ignore', stderr: 'pipe' }
  );

  if ((await openssl.exited) !== 0) {
    throw new Error(
      `openssl could not make the test certificate: ${await new Response(openssl.stderr).text()}`
    );
  }

  return {
    certificate: await Bun.file(certificatePath).text(),
    key: await Bun.file(keyPath).text(),
  };
}

const expectedKeys = [
  'action',
  'alert_id',
  'delivery_id',
  'group_id',
  'group_name',
  'open_for',
  'reason',
  'reminder',
  'rule',
  'sent_at',
  'session_address',
  'session_role',
  'severity',
  'summary',
  'target_id',
  'task_title',
  'workspace_id',
];

type Sent = { url: string; init: RequestInit & { tls?: { serverName?: string; ca?: string } } };

function alertOf(rule: AlertRule, overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: requireAlertId('alr_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    workspaceId: defaultWorkspaceId,
    groupId: null,
    rule,
    targetId: 'ses_unknown',
    severity: 'critical',
    reason: null,
    openedAt: '2026-11-19T09:00:00.000Z',
    lastSeenAt: '2026-11-19T09:55:00.000Z',
    clearedAt: null,
    notifiedAt: null,
    ...overrides,
  };
}

function notificationOf(rule: AlertRule, overrides: Partial<AlertRecord> = {}): Notification {
  return toNotification(
    { groups: [], tasks: [], sessions: [] },
    alertOf(rule, overrides),
    'delivery-1',
    false,
    sentAt
  );
}

function recordingFetch(status = 200) {
  const sent: Sent[] = [];
  const fetchOnce = async (url: string, init: Sent['init']) => {
    sent.push({ url, init });

    return new Response(null, { status });
  };

  return { sent, fetchOnce };
}

function bodyOf(sent: Sent | undefined): Record<string, unknown> {
  return JSON.parse(String(requirePresent(sent, 'a request should have been sent').init.body));
}

function headersOf(sent: Sent | undefined): Record<string, string> {
  return Object.fromEntries(
    new Headers(requirePresent(sent, 'a request should have been sent').init.headers)
  );
}

function publicLookup() {
  return async () => ['93.184.216.34'];
}

function notifierFor(fetchOnce: ReturnType<typeof recordingFetch>['fetchOnce']) {
  return createWebhookNotifier({
    url: hookUrl,
    secret,
    fetch: fetchOnce,
    lookupHost: publicLookup(),
  });
}

test.each(alertRules)('the body for a %s alert is flat and every value is a string', async rule => {
  const { sent, fetchOnce } = recordingFetch();

  await notifierFor(fetchOnce).deliver(notificationOf(rule));

  const body = bodyOf(sent[0]);

  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  expect(Object.values(body).every(value => typeof value === 'string')).toBe(true);
  expect(body.rule).toBe(rule);
  expect(body.target_id).toBe('ses_unknown');
  expect(body.summary).not.toBe('');
  expect(body.action).not.toBe('');
});

test('a value that is missing is an empty string, not null', async () => {
  const { sent, fetchOnce } = recordingFetch();

  await notifierFor(fetchOnce).deliver(notificationOf('session_dead'));

  const body = bodyOf(sent[0]);

  expect(body.group_id).toBe('');
  expect(body.group_name).toBe('');
  expect(body.task_title).toBe('');
  expect(body.session_role).toBe('');
  expect(body.session_address).toBe('');
  expect(body.reason).toBe('');
  expect(body.reminder).toBe('false');
});

test('a reminder says so, and every field of a full notification stays a string', async () => {
  const { sent, fetchOnce } = recordingFetch();
  const full: Notification = {
    ...notificationOf('escalation'),
    reminder: true,
    groupId: 'grp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    groupName: 'Checkout',
    taskTitle: 'Fix the tax rounding',
    sessionRole: 'implementer',
    sessionAddress: 'https://platform.example.com/sessions/abc',
    openFor: '61 minutes',
    reason: 'I am blocked on a decision.',
  };

  await notifierFor(fetchOnce).deliver(full);

  const body = bodyOf(sent[0]);

  expect(Object.keys(body).sort()).toEqual(expectedKeys);
  expect(Object.values(body).every(value => typeof value === 'string')).toBe(true);
  expect(body).toMatchObject({
    reminder: 'true',
    group_name: 'Checkout',
    task_title: 'Fix the tax rounding',
    session_role: 'implementer',
    open_for: '61 minutes',
  });
});

test('the reason of an escalation is the string reason in the body', async () => {
  const { sent, fetchOnce } = recordingFetch();

  await notifierFor(fetchOnce).deliver(
    notificationOf('escalation', { reason: 'Blocked on a decision.' })
  );

  expect(bodyOf(sent[0]).reason).toBe('Blocked on a decision.');
});

test('the request carries the signature, never the secret', async () => {
  const { sent, fetchOnce } = recordingFetch();

  await notifierFor(fetchOnce).deliver(notificationOf('budget_80', { severity: 'normal' }));

  const request = requirePresent(sent[0], 'a request should have been sent');
  const headers = headersOf(request);
  const text = String(request.init.body);
  const expected = createHmac('sha256', secret).update(`${sentAt}.${text}`).digest('hex');

  expect(headers['hivemind-timestamp']).toBe(sentAt);
  expect(headers['hivemind-signature']).toBe(`v1=${expected}`);
  expect(headers['hivemind-signature']).toBe(`v1=${webhookSignature(secret, sentAt, text)}`);
  expect(headers['hivemind-delivery']).toBe('delivery-1');
  expect(text).not.toContain(secret);
  expect(Object.values(headers).join(' ')).not.toContain(secret);
});

test('the request connects to the address it resolved and names the original host without the port', async () => {
  const { sent, fetchOnce } = recordingFetch();
  let lookups = 0;

  await createWebhookNotifier({
    url: 'https://hooks.example.com:8443/workflows/T0123',
    secret,
    fetch: fetchOnce,
    lookupHost: async host => {
      lookups += 1;
      expect(host).toBe('hooks.example.com');

      return ['93.184.216.34'];
    },
  }).deliver(notificationOf('session_dead'));

  const request = requirePresent(sent[0], 'a request should have been sent');
  const url = new URL(request.url);

  expect(url.hostname).toBe('93.184.216.34');
  expect(url.port).toBe('8443');
  expect(url.pathname).toBe('/workflows/T0123');
  expect(headersOf(request).host).toBe('hooks.example.com');
  expect(request.init.tls?.serverName).toBe('hooks.example.com');
  expect(request.init.redirect).toBe('manual');
  expect(request.init.method).toBe('POST');
  expect(lookups).toBe(1);
});

test('an IPv4 address is tried before an IPv6 one, and the next is tried when the connection fails', async () => {
  const urls: string[] = [];
  const notifier = createWebhookNotifier({
    url: hookUrl,
    secret,
    lookupHost: async () => ['2606:4700:4700::1111', '93.184.216.34', '8.8.8.8'],
    fetch: async url => {
      urls.push(new URL(url).hostname);

      if (urls.length < 3) throw Object.assign(new Error('refused'), { code: 'ConnectionRefused' });

      return new Response(null, { status: 200 });
    },
  });

  await notifier.deliver(notificationOf('session_dead'));

  expect(urls).toEqual(['93.184.216.34', '8.8.8.8', '[2606:4700:4700::1111]']);
});

test('a response from the first address ends the attempts, even when it is an error', async () => {
  const urls: string[] = [];
  const notifier = createWebhookNotifier({
    url: hookUrl,
    secret,
    lookupHost: async () => ['93.184.216.34', '8.8.8.8'],
    fetch: async url => {
      urls.push(new URL(url).hostname);

      return new Response(null, { status: 400 });
    },
  });

  await expect(notifier.deliver(notificationOf('session_dead'))).rejects.toThrow(
    'The webhook did not accept the notification (HTTP 400).'
  );
  expect(urls).toEqual(['93.184.216.34']);
});

test('every address failing is one failed delivery that names the error code and no address', async () => {
  const notifier = createWebhookNotifier({
    url: hookUrl,
    secret,
    lookupHost: async () => ['93.184.216.34', '8.8.8.8'],
    fetch: async url => {
      throw Object.assign(new Error(`could not connect to ${url}`), { code: 'ConnectionRefused' });
    },
  });
  const failure = await notifier.deliver(notificationOf('session_dead')).catch(error => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('The webhook request failed (ConnectionRefused).');
});

test('a redirect is refused and never followed', async () => {
  const { fetchOnce, sent } = recordingFetch(302);

  await expect(notifierFor(fetchOnce).deliver(notificationOf('session_dead'))).rejects.toThrow(
    'The webhook refused to follow a redirect.'
  );
  expect(sent).toHaveLength(1);
});

test('a response that is not a success is a failed delivery that names the status', async () => {
  await expect(
    notifierFor(recordingFetch(500).fetchOnce).deliver(notificationOf('session_dead'))
  ).rejects.toThrow('The webhook did not accept the notification (HTTP 500).');
});

test('a name that resolves to a private address sends nothing', async () => {
  const { sent, fetchOnce } = recordingFetch();
  const notifier = createWebhookNotifier({
    url: hookUrl,
    secret,
    fetch: fetchOnce,
    lookupHost: async () => ['10.0.0.5'],
  });

  await expect(notifier.deliver(notificationOf('session_dead'))).rejects.toThrow(
    'The webhook address is not a public network.'
  );
  expect(sent).toHaveLength(0);
});

test.each([
  [
    'an error with a code',
    Object.assign(new Error('getaddrinfo ENOTFOUND hooks.example.test'), { code: 'ENOTFOUND' }),
    'ENOTFOUND',
  ],
  ['an error without a code', new Error('could not look up hooks.example.test'), 'Error'],
])(
  'a failed name lookup, as %s, names only its code and never the host',
  async (_label, failure, code) => {
    const { sent, fetchOnce } = recordingFetch();
    const notifier = createWebhookNotifier({
      url: hookUrl,
      secret,
      fetch: fetchOnce,
      lookupHost: async () => {
        throw failure;
      },
    });

    await expect(notifier.deliver(notificationOf('session_dead'))).rejects.toMatchObject({
      message: `The webhook name could not be resolved (${code}).`,
    });
    expect(sent).toHaveLength(0);
  }
);

test('a host that never answers is cut off at the time limit', async () => {
  let signal: AbortSignal | null | undefined;
  const notifier = createWebhookNotifier({
    url: hookUrl,
    secret,
    timeoutMs: 50,
    lookupHost: publicLookup(),
    fetch: (_url, init) => {
      signal = init.signal;

      return new Promise<Response>(() => undefined);
    },
  });
  const started = Date.now();

  await expect(notifier.deliver(notificationOf('session_dead'))).rejects.toThrow(
    'The webhook did not answer in time.'
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(signal?.aborted).toBe(true);
});

test('a name lookup that never answers is cut off at the time limit', async () => {
  const notifier = createWebhookNotifier({
    url: hookUrl,
    secret,
    timeoutMs: 50,
    lookupHost: () => new Promise<string[]>(() => undefined),
    fetch: recordingFetch().fetchOnce,
  });
  const started = Date.now();

  await expect(notifier.deliver(notificationOf('session_dead'))).rejects.toThrow(
    'The webhook did not answer in time.'
  );
  expect(Date.now() - started).toBeLessThan(2000);
});

function listen(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });

  runAfterTest(() => server.stop(true));

  return server;
}

async function listenSecurely(handler: (request: Request) => Response | Promise<Response>) {
  const { certificate, key } = await testCredentials();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificate, key },
    fetch: handler,
  });

  runAfterTest(() => server.stop(true));

  return server;
}

test('a signed notification reaches a real loopback server with the host name it was given', async () => {
  const received: { headers: Headers; text: string }[] = [];
  const server = listen(async request => {
    received.push({ headers: request.headers, text: await request.text() });

    return new Response('ok');
  });
  const notifier = createWebhookNotifier({ url: `http://127.0.0.1:${server.port}/hook`, secret });

  await notifier.deliver(notificationOf('wait_cycle'));

  const first = requirePresent(received[0], 'the server should have received a request');

  expect(received).toHaveLength(1);
  expect(first.headers.get('host')).toBe(`127.0.0.1:${server.port}`);
  expect(first.headers.get('hivemind-delivery')).toBe('delivery-1');
  expect(first.headers.get('hivemind-signature')).toBe(
    `v1=${webhookSignature(secret, sentAt, first.text)}`
  );
  expect(Object.keys(JSON.parse(first.text) as object).sort()).toEqual(expectedKeys);
});

test('a real server that redirects is not followed', async () => {
  let followed = 0;
  const target = listen(() => {
    followed += 1;

    return new Response('moved here');
  });
  const server = listen(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${target.port}/elsewhere` },
      })
  );
  const notifier = createWebhookNotifier({ url: `http://127.0.0.1:${server.port}/hook`, secret });

  await expect(notifier.deliver(notificationOf('wait_cycle'))).rejects.toThrow(
    'The webhook refused to follow a redirect.'
  );
  expect(followed).toBe(0);
});

test('a real server that never answers is cut off at the time limit and the request is closed', async () => {
  let clientGone = false;
  const server = listen(async request => {
    await new Promise<void>(resolve =>
      request.signal.addEventListener('abort', () => {
        clientGone = true;
        resolve();
      })
    );

    return new Response('too late');
  });
  const notifier = createWebhookNotifier({
    url: `http://127.0.0.1:${server.port}/hook`,
    secret,
    timeoutMs: 100,
  });
  const started = Date.now();

  await expect(notifier.deliver(notificationOf('wait_cycle'))).rejects.toThrow(
    'The webhook did not answer in time.'
  );
  expect(Date.now() - started).toBeLessThan(2000);

  await Bun.sleep(100);

  expect(clientGone).toBe(true);
});

test('a success is a success once the headers arrive, even when the body never finishes', async () => {
  const server = listen(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
          },
        }),
        { status: 200 }
      )
  );
  const notifier = createWebhookNotifier({
    url: `http://127.0.0.1:${server.port}/hook`,
    secret,
    timeoutMs: 5000,
  });
  const started = Date.now();

  await notifier.deliver(notificationOf('wait_cycle'));

  expect(Date.now() - started).toBeLessThan(2000);
});

function portOf(server: { port: number | undefined }): number {
  return requirePresent(server.port, 'the server should have a port');
}

async function httpsNotifier(port: number, host: string, extra: { trust?: boolean } = {}) {
  return createWebhookNotifier({
    url: `https://${host}:${port}/workflows/T0123`,
    secret,
    checkAddresses: async () => ['127.0.0.1'],
    ...(extra.trust === false ? {} : { trustedCertificate: (await testCredentials()).certificate }),
  });
}

test('an https server on a port that is not the default receives the notification at the pinned address', async () => {
  const received: { host: string | null; text: string }[] = [];
  const server = await listenSecurely(async request => {
    received.push({ host: request.headers.get('host'), text: await request.text() });

    return new Response('ok');
  });

  await (await httpsNotifier(portOf(server), 'hooks.example.test')).deliver(
    notificationOf('wait_cycle')
  );

  const first = requirePresent(received[0], 'the server should have received a request');

  expect(received).toHaveLength(1);
  expect(first.host).toBe('hooks.example.test');
  expect(Object.keys(JSON.parse(first.text) as object).sort()).toEqual(expectedKeys);
});

test('an https server whose certificate is for another name is refused before anything is sent', async () => {
  const received: string[] = [];
  const server = await listenSecurely(async request => {
    received.push(await request.text());

    return new Response('ok');
  });
  const failure = await (await httpsNotifier(portOf(server), 'other.example.test'))
    .deliver(notificationOf('wait_cycle'))
    .catch(error => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    'The webhook request failed (ERR_TLS_CERT_ALTNAME_INVALID).'
  );
  expect(received).toHaveLength(0);
});

test('an https server whose certificate is not trusted is refused before anything is sent', async () => {
  const received: string[] = [];
  const server = await listenSecurely(async request => {
    received.push(await request.text());

    return new Response('ok');
  });

  await expect(
    (await httpsNotifier(portOf(server), 'untrusted.example.test', { trust: false })).deliver(
      notificationOf('wait_cycle')
    )
  ).rejects.toThrow('The webhook request failed');
  expect(received).toHaveLength(0);
});

const proxyRefusal =
  'HIVEMIND_WEBHOOK_URL cannot be an http address while HTTP_PROXY is set, because the request would go through the proxy unencrypted. Use https, or add the host to NO_PROXY.';

function startupWith(url: string, proxy: Record<string, string>) {
  return () =>
    webhookNotifierFromEnv({
      HIVEMIND_WEBHOOK_URL: url,
      HIVEMIND_WEBHOOK_SECRET: secret,
      ...proxy,
    });
}

test.each(['HTTP_PROXY', 'http_proxy'])(
  'an http webhook address is refused at startup while %s is set, and the message does not repeat it',
  variable => {
    expect(
      startupWith('http://127.0.0.1:8788/workflows/T0123', {
        [variable]: 'http://proxy.example:8080',
      })
    ).toThrow(proxyRefusal);
  }
);

test.each([
  ['127.0.0.1', 'http://127.0.0.1:8788/hook'],
  ['127.0.0.1', 'http://localhost:8788/hook'],
  ['*', 'http://127.0.0.1:8788/hook'],
  ['example.com, 127.0.0.1', 'http://127.0.0.1:8788/hook'],
  ['[::1]', 'http://[::1]:8788/hook'],
])('NO_PROXY %j keeps a request for %s direct', (noProxy, url) => {
  expect(
    startupWith(url, { HTTP_PROXY: 'http://proxy.example:8080', NO_PROXY: noProxy })()
  ).not.toBeNull();
});

test.each([
  ['localhost', 'http://127.0.0.1:8788/hook'],
  ['127.0.0.0/8', 'http://127.0.0.1:8788/hook'],
  ['.example.com', 'http://127.0.0.1:8788/hook'],
  ['localhost', 'http://localhost:8788/hook'],
  ['::1', 'http://[::1]:8788/hook'],
])(
  'NO_PROXY %j does not keep a request for %s direct, because Bun matches the address in the request',
  (noProxy, url) => {
    expect(
      startupWith(url, { HTTP_PROXY: 'http://proxy.example:8080', NO_PROXY: noProxy })
    ).toThrow(proxyRefusal);
  }
);

const proxyAddress = 'http://proxy.example:8080';
const loopbackHook = 'http://127.0.0.1:8788/hook';

test.each([
  ['an empty HTTP_PROXY while http_proxy is set', { HTTP_PROXY: '', http_proxy: proxyAddress }],
  ['NO_PROXY=* while no_proxy is empty', { HTTP_PROXY: proxyAddress, NO_PROXY: '*', no_proxy: '' }],
  [
    'NO_PROXY=* while no_proxy lists another host',
    { HTTP_PROXY: proxyAddress, NO_PROXY: '*', no_proxy: 'example.com' },
  ],
])('startup refuses %s, because Bun reads the lowercase variable first', (_label, proxy) => {
  expect(startupWith(loopbackHook, proxy)).toThrow(proxyRefusal);
});

test.each([
  ['an empty http_proxy while HTTP_PROXY is set', { HTTP_PROXY: proxyAddress, http_proxy: '' }],
  ['no_proxy=* while NO_PROXY is empty', { HTTP_PROXY: proxyAddress, NO_PROXY: '', no_proxy: '*' }],
  [
    'no_proxy listing the address while NO_PROXY lists another host',
    { HTTP_PROXY: proxyAddress, NO_PROXY: 'example.com', no_proxy: '127.0.0.1' },
  ],
])('startup accepts %s, because Bun reads the lowercase variable first', (_label, proxy) => {
  expect(startupWith(loopbackHook, proxy)()).not.toBeNull();
});

test.each([
  ['http://localhost:8788/hook', 'http://127.0.0.1:8788/hook'],
  ['http://127.0.0.1:8788/hook', 'http://127.0.0.1:8788/hook'],
  ['http://[::1]:8788/hook', 'http://[::1]:8788/hook'],
])(
  'an http webhook at %s is requested at %s, the address NO_PROXY is matched against',
  async (url, requested) => {
    const { sent, fetchOnce } = recordingFetch();

    await createWebhookNotifier({ url, secret, fetch: fetchOnce }).deliver(
      notificationOf('wait_cycle')
    );

    expect(requirePresent(sent[0], 'a request should have been sent').url).toBe(requested);
  }
);

test.each([
  [
    'an https address while HTTP_PROXY is set',
    'https://hooks.example.com/hook',
    { HTTP_PROXY: 'http://proxy.example:8080' },
  ],
  [
    'an http address while only HTTPS_PROXY is set',
    'http://127.0.0.1:8788/hook',
    { HTTPS_PROXY: 'http://proxy.example:8080' },
  ],
  [
    'an http address while only ALL_PROXY is set',
    'http://127.0.0.1:8788/hook',
    { ALL_PROXY: 'http://proxy.example:8080' },
  ],
  ['an http address while HTTP_PROXY is empty', 'http://127.0.0.1:8788/hook', { HTTP_PROXY: '' }],
])('startup accepts %s', (_label, url, proxy) => {
  expect(startupWith(url, proxy)()).not.toBeNull();
});

test('no webhook address means no notifier', () => {
  expect(webhookNotifierFromEnv({})).toBeNull();
  expect(webhookNotifierFromEnv({ HIVEMIND_WEBHOOK_URL: '' })).toBeNull();
});

test('a webhook address without a secret is an error at startup', () => {
  expect(() => webhookNotifierFromEnv({ HIVEMIND_WEBHOOK_URL: hookUrl })).toThrow(
    'HIVEMIND_WEBHOOK_SECRET is not set.'
  );
});

test('a webhook address that is not an address is an error at startup', () => {
  expect(() =>
    webhookNotifierFromEnv({ HIVEMIND_WEBHOOK_URL: 'not a url', HIVEMIND_WEBHOOK_SECRET: secret })
  ).toThrow('HIVEMIND_WEBHOOK_URL is not a valid address.');
});

test.each([
  ['http://hooks.slack.com/services/T000/B000/XXXX', 'HIVEMIND_WEBHOOK_URL must use https.'],
  ['ftp://hooks.example.com/XXXX', 'HIVEMIND_WEBHOOK_URL must use https.'],
  ['javascript:alert(1)', 'HIVEMIND_WEBHOOK_URL must use https.'],
  ['https://10.0.0.1/services/XXXX', 'HIVEMIND_WEBHOOK_URL is not a public network.'],
  ['https://localhost/services/XXXX', 'HIVEMIND_WEBHOOK_URL is not a public network.'],
  ['https://[::ffff:7f00:1]/services/XXXX', 'HIVEMIND_WEBHOOK_URL is not a public network.'],
])('the webhook address %s stops the service at startup without repeating it', (url, message) => {
  const failure = (() => {
    try {
      webhookNotifierFromEnv({ HIVEMIND_WEBHOOK_URL: url, HIVEMIND_WEBHOOK_SECRET: secret });
    } catch (error) {
      return error;
    }

    return null;
  })();

  expect((failure as Error | null)?.message).toBe(message);
});

test.each(['https://hooks.slack.com/services/T000/B000/XXXX', 'http://127.0.0.1:8080/hook'])(
  'the webhook address %s makes a notifier',
  url => {
    const notifier = webhookNotifierFromEnv({
      HIVEMIND_WEBHOOK_URL: url,
      HIVEMIND_WEBHOOK_SECRET: secret,
    });

    expect(typeof notifier?.deliver).toBe('function');
  }
);
