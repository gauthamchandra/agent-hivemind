import { expect, test } from 'bun:test';
import http from 'node:http';
import { createWebhookNotifier, isBlockedAddress, webhookSignature } from '@/notify/webhook.ts';

test('a webhook signature covers the timestamp and the body', () => {
  const body = '{"version":1}';
  const signature = webhookSignature('secret', '2026-11-17T00:00:00.000Z', body);

  expect(signature).toBe(webhookSignature('secret', '2026-11-17T00:00:00.000Z', body));
  expect(signature).not.toBe(webhookSignature('other', '2026-11-17T00:00:00.000Z', body));
});

test('the webhook refuses a private, loopback, or link-local address', async () => {
  const calls: string[] = [];
  const notifier = createWebhookNotifier({
    url: 'https://10.1.2.3/hook',
    secret: 'secret',
    fetch: async () => {
      calls.push('sent');

      return new Response('ok');
    },
    lookupHost: async () => ['10.1.2.3'],
  });

  await expect(
    notifier.deliver({
      deliveryId: 'delivery-1',
      workspaceId: 'ws_default',
      sentAt: '2026-11-17T00:00:00.000Z',
      recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
      findings: [],
    })
  ).rejects.toThrow('public network');
  expect(calls).toHaveLength(0);
  expect(isBlockedAddress('127.0.0.1')).toBe(true);
  expect(isBlockedAddress('192.168.0.8')).toBe(true);
  expect(isBlockedAddress('169.254.1.1')).toBe(true);
  expect(isBlockedAddress('::1')).toBe(true);
  expect(isBlockedAddress('1.1.1.1')).toBe(false);
  expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
  expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  expect(isBlockedAddress('::127.0.0.1')).toBe(true);
  expect(isBlockedAddress('fe90::1')).toBe(true);
  expect(isBlockedAddress('febf::1')).toBe(true);
  expect(isBlockedAddress('100.64.0.1')).toBe(true);
  expect(isBlockedAddress('64:ff9b::1.1.1.1')).toBe(true);
  expect(isBlockedAddress('2001:db8::1')).toBe(false);
});

test('the webhook signs the request and does not follow a redirect', async () => {
  const seen: { signature: string | null; delivery: string | null; redirected: string }[] = [];
  const notifier = createWebhookNotifier({
    url: 'https://alerts.example/hook',
    secret: 'secret',
    lookupHost: async () => ['1.1.1.1'],
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);

      seen.push({
        signature: headers.get('hivemind-signature'),
        delivery: headers.get('hivemind-delivery'),
        redirected: String(init?.redirect),
      });

      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/hook' } });
    },
  });

  await expect(
    notifier.deliver({
      deliveryId: 'delivery-2',
      workspaceId: 'ws_default',
      sentAt: '2026-11-17T00:00:00.000Z',
      recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
      findings: [],
    })
  ).rejects.toThrow('redirect');

  expect(seen).toHaveLength(1);
  expect(seen[0]?.redirected).toBe('manual');
  expect(seen[0]?.delivery).toBe('delivery-2');
  expect(seen[0]?.signature).toBe(
    `v1=${webhookSignature('secret', '2026-11-17T00:00:00.000Z', seenBody())}`
  );
});

test('the webhook requires https except on loopback', async () => {
  const notifier = createWebhookNotifier({
    url: 'http://alerts.example/hook',
    secret: 'secret',
    lookupHost: async () => ['1.1.1.1'],
    fetch: async () => new Response('ok'),
  });

  await expect(
    notifier.deliver({
      deliveryId: 'delivery-4',
      workspaceId: 'ws_default',
      sentAt: '2026-11-17T00:00:00.000Z',
      recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
      findings: [],
    })
  ).rejects.toThrow('https');

  let requested = '';
  const loopback = createWebhookNotifier({
    url: 'http://127.0.0.1/hook',
    secret: 'secret',
    fetch: async input => {
      requested = input;

      return new Response('ok');
    },
  });

  await loopback.deliver({
    deliveryId: 'delivery-5',
    workspaceId: 'ws_default',
    sentAt: '2026-11-17T00:00:00.000Z',
    recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
    findings: [],
  });

  expect(new URL(requested).hostname).toBe('127.0.0.1');
});

test('the webhook connects to the address it already checked', async () => {
  let requested = '';
  const notifier = createWebhookNotifier({
    url: 'https://alerts.example/hook',
    secret: 'secret',
    lookupHost: async () => ['1.1.1.1'],
    fetch: async (input, init) => {
      requested = input;
      const host = new Headers(init?.headers).get('host');

      expect(host).toBe('alerts.example');

      return new Response('ok');
    },
  });

  await notifier.deliver({
    deliveryId: 'delivery-3',
    workspaceId: 'ws_default',
    sentAt: '2026-11-17T00:00:00.000Z',
    recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
    findings: [],
  });

  expect(new URL(requested).hostname).toBe('1.1.1.1');
});

test('a silent webhook fails instead of holding the tick', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise(() => undefined),
  });
  const notifier = createWebhookNotifier({
    url: `http://127.0.0.1:${server.port}/hook`,
    secret: 'secret',
    timeoutMs: 30,
  });

  await expect(
    notifier.deliver({
      deliveryId: 'delivery-6',
      workspaceId: 'ws_default',
      sentAt: '2026-11-17T00:00:00.000Z',
      recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
      findings: [],
    })
  ).rejects.toThrow('time');

  server.stop(true);
});

test('an out-of-range webhook status rejects the delivery', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(600);
    res.end('no');
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const notifier = createWebhookNotifier({
    url: `http://127.0.0.1:${port}/hook`,
    secret: 'secret',
    timeoutMs: 1000,
  });

  try {
    await expect(
      notifier.deliver({
        deliveryId: 'delivery-7',
        workspaceId: 'ws_default',
        sentAt: '2026-11-17T00:00:00.000Z',
        recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
        findings: [],
      })
    ).rejects.toThrow('status');
  } finally {
    server.close();
  }
});

function seenBody(): string {
  return JSON.stringify({
    version: 1,
    delivery_id: 'delivery-2',
    workspace_id: 'ws_default',
    sent_at: '2026-11-17T00:00:00.000Z',
    recipient: { kind: 'owner', id: 'per_owner', subject: null, address: null },
    findings: [],
  });
}
