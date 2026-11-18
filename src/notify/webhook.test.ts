import { expect, test } from 'bun:test';
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
    url: 'http://10.1.2.3/hook',
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
