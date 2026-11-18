import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Notification, Notifier } from '@/ports/notifier.ts';

export type WebhookOptions = {
  url: string;
  secret: string;
  allowPrivate?: boolean;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  lookupHost?: (host: string) => Promise<string[]>;
};

/** Sign `timestamp.body` so a receiver can reject a request it did not expect. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function createWebhookNotifier(options: WebhookOptions): Notifier {
  const send = options.fetch ?? fetch;
  const resolve = options.lookupHost ?? defaultLookup;

  return {
    async deliver(notification) {
      const target = new URL(options.url);

      if (!options.allowPrivate) await refusePrivate(target, resolve);

      const body = JSON.stringify(bodyOf(notification));
      const timestamp = notification.sentAt;
      const signature = webhookSignature(options.secret, timestamp, body);
      const response = await send(target.toString(), {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'hivemind-timestamp': timestamp,
          'hivemind-signature': `v1=${signature}`,
          'hivemind-delivery': notification.deliveryId,
        },
        body,
      });

      if (response.status >= 300 && response.status < 400) {
        throw new Error('The webhook refused to follow a redirect.');
      }

      if (!response.ok) throw new Error('The webhook did not accept the notification.');
    },
  };
}

export async function refusePrivate(
  target: URL,
  resolve: (host: string) => Promise<string[]>
): Promise<void> {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('The webhook address is not an HTTP address.');
  }

  const host = target.hostname.replace(/^\[|\]$/g, '');

  if (isBlockedName(host) || isBlockedAddress(host)) {
    throw new Error('The webhook address is not a public network.');
  }

  if (isIP(host) !== 0) return;

  const addresses = await resolve(host);

  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new Error('The webhook address is not a public network.');
  }
}

function bodyOf(notification: Notification) {
  return {
    version: 1,
    delivery_id: notification.deliveryId,
    workspace_id: notification.workspaceId,
    sent_at: notification.sentAt,
    recipient: notification.recipient,
    findings: notification.findings,
  };
}

async function defaultLookup(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true, verbatim: true });

  return rows.map(row => row.address);
}

function isBlockedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');

  return name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal';
}

export function isBlockedAddress(host: string): boolean {
  const version = isIP(host);

  if (version === 4) return blockedV4(host);
  if (version === 6) return blockedV6(host);

  return false;
}

function blockedV4(host: string): boolean {
  const parts = host.split('.').map(part => Number(part));

  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;

  const [a, b] = parts;

  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;

  return false;
}

function blockedV6(host: string): boolean {
  const address = host.toLowerCase();

  if (address === '::1' || address === '::') return true;
  if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd'))
    return true;
  if (address.startsWith('::ffff:')) return isBlockedAddress(address.slice('::ffff:'.length));

  return false;
}
