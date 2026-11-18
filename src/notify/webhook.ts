import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { Notification, Notifier } from '@/ports/notifier.ts';

const webhookTimeoutMs = 15_000;

export type WebhookOptions = {
  url: string;
  secret: string;
  allowPrivate?: boolean;
  timeoutMs?: number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  lookupHost?: (host: string) => Promise<string[]>;
};

/** Sign `timestamp.body` so a receiver can reject a request it did not expect. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function createWebhookNotifier(options: WebhookOptions): Notifier {
  const resolve = options.lookupHost ?? defaultLookup;

  return {
    async deliver(notification) {
      const target = new URL(options.url);
      const pinned = options.allowPrivate ? null : await checkedAddress(target, resolve);
      const body = JSON.stringify(bodyOf(notification));
      const timestamp = notification.sentAt;
      const signature = webhookSignature(options.secret, timestamp, body);
      const requestUrl = new URL(target.toString());

      if (pinned !== null) requestUrl.hostname = bracket(pinned);

      const headers = {
        host: target.host,
        'content-type': 'application/json',
        'hivemind-timestamp': timestamp,
        'hivemind-signature': `v1=${signature}`,
        'hivemind-delivery': notification.deliveryId,
      };
      const response = options.fetch
        ? await options.fetch(requestUrl.toString(), {
            method: 'POST',
            redirect: 'manual',
            headers,
            body,
          })
        : await connectPinned(
            target,
            pinned ?? unbracket(target.hostname),
            headers,
            body,
            options.timeoutMs ?? webhookTimeoutMs
          );

      if (response.status >= 300 && response.status < 400) {
        throw new Error('The webhook refused to follow a redirect.');
      }

      if (!response.ok) throw new Error('The webhook did not accept the notification.');
    },
  };
}

/** Resolve the name once and return the address the request must connect to. */
export async function checkedAddress(
  target: URL,
  resolve: (host: string) => Promise<string[]>
): Promise<string> {
  const host = target.hostname.replace(/^\[|\]$/g, '');

  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopback(host))) {
    throw new Error('The webhook address must use https.');
  }

  if (target.protocol === 'http:' && isLoopback(host)) return host;

  if (isBlockedName(host) || isBlockedAddress(host)) {
    throw new Error('The webhook address is not a public network.');
  }

  if (addressBytes(host) !== null) return host;

  const addresses = await resolve(host);
  const chosen = addresses[0];

  if (chosen === undefined || addresses.some(isBlockedAddress)) {
    throw new Error('The webhook address is not a public network.');
  }

  return chosen;
}

function bracket(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

function unbracket(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

function connectPinned(
  target: URL,
  pinned: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<Response> {
  const secure = target.protocol === 'https:';
  const lib = secure ? https : http;
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: Response) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else if (response !== undefined) resolve(response);
    };
    const req = lib.request(
      {
        host: pinned,
        servername: target.hostname,
        port,
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers,
      },
      res => {
        res.on('data', () => undefined);
        res.on('end', () => {
          const status = res.statusCode ?? 500;

          if (status < 200 || status > 599) {
            finish(new Error(`The webhook returned unsupported status ${status}.`));
          } else {
            finish(undefined, new Response(null, { status }));
          }
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error('The webhook did not answer in time.'));
    }, timeoutMs);

    req.on('error', error => {
      const cause = error instanceof Error ? error : new Error('The webhook request failed.');

      finish(cause);
    });
    req.end(body);
  });
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

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isBlockedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');

  return name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal';
}

export function isBlockedAddress(host: string): boolean {
  const bytes = addressBytes(host);

  if (bytes === null) return false;
  if (bytes.length === 4) return blocked4(bytes);

  return blocked6(bytes);
}

function addressBytes(host: string): Uint8Array | null {
  return ipv4(host) ?? ipv6(host);
}

function ipv4(host: string): Uint8Array | null {
  const parts = host.split('.');

  if (parts.length !== 4) return null;

  const bytes = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));

  if (bytes.some(part => !Number.isInteger(part) || part > 255)) return null;

  return Uint8Array.from(bytes);
}

function ipv6(host: string): Uint8Array | null {
  let text = host.toLowerCase();
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);

  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    const tail = ipv4(dotted[2]);

    if (tail === null) return null;

    const high = ((tail[0] ?? 0) << 8) | (tail[1] ?? 0);
    const low = ((tail[2] ?? 0) << 8) | (tail[3] ?? 0);

    text = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split('::');

  if (halves.length > 2) return null;

  const left = hextets(halves[0] ?? '');
  const right = halves.length === 2 ? hextets(halves[1] ?? '') : [];

  if (left === null || right === null) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;

  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array<number>(zeros).fill(0), ...right];
  const bytes = new Uint8Array(16);

  parts.forEach((part, index) => {
    bytes[index * 2] = part >> 8;
    bytes[index * 2 + 1] = part & 0xff;
  });

  return bytes;
}

function hextets(text: string): number[] | null {
  if (text === '') return [];

  const parts = text.split(':');

  if (parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  return parts.map(part => Number.parseInt(part, 16));
}

function blocked4(bytes: Uint8Array): boolean {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;

  return false;
}

function blocked6(bytes: Uint8Array): boolean {
  if (zeros(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return blocked4(bytes.subarray(12, 16));
  }

  if (zeros(bytes, 0, 12)) return blocked4(bytes.subarray(12, 16));
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true;
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return zeros(bytes, 4, 12);
  }

  return false;
}

function zeros(bytes: Uint8Array, from: number, until: number): boolean {
  return bytes.slice(from, until).every(byte => byte === 0);
}
