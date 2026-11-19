import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { webhookTimeoutMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import { checkedAddresses, checkWebhookTarget, httpRequestAddress } from '@/notify/address.ts';
import type { Notification, Notifier } from '@/ports/notifier.ts';

type RequestInitWithTls = RequestInit & { tls?: { serverName?: string; ca?: string } };

export type WebhookOptions = {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetch?: (input: string, init: RequestInitWithTls) => Promise<Response>;
  lookupHost?: (host: string) => Promise<string[]>;
  /** For tests only: a certificate to trust in addition to the system's, so a test server can answer over https. */
  trustedCertificate?: string;
  /** For tests only: replaces the check that an address is public, so a test server on loopback can answer over https. */
  checkAddresses?: (target: URL) => Promise<string[]>;
};

/** Sign `timestamp.body` so a receiver can reject a request it did not expect. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Make a notifier that sends each notification as one signed POST.
 *
 * <p>The body is a flat object whose every value is a string, because a Slack Workflow webhook
 * trigger takes only flat key-value pairs. The whole delivery, from the name lookup to the headers
 * of the response, is cut off after {@code timeoutMs}, so a host that never answers cannot hold the
 * run that sends it. A redirect is refused.
 *
 * <p>The request connects to an address that was checked and verifies the certificate against the
 * original host name. On https the Host header carries that name without the port, because Bun
 * checks the certificate against the Host header and the port would make every name fail.
 * Keeping the port and checking the name afterwards with {@code checkServerIdentity} does not
 * work either: Bun then sends the request before it rejects a certificate for another name. A
 * failure names an error code or a status, never the address, the host, or the body.
 */
export function createWebhookNotifier(options: WebhookOptions): Notifier {
  const resolve = lookupFailingWithCodeOnly(options.lookupHost ?? defaultLookup);
  const timeoutMs = options.timeoutMs ?? webhookTimeoutMs;

  return {
    deliver(notification) {
      return withinTime(timeoutMs, signal => send(options, resolve, notification, signal));
    },
  };
}

/**
 * Read the webhook from the environment. No address means no notifier. An address needs a secret,
 * and an address that can never be safe stops the service at startup. The address is never put in
 * a message, because a Slack workflow address is a secret.
 */
export function webhookNotifierFromEnv(env: Record<string, string | undefined>): Notifier | null {
  const url = env.HIVEMIND_WEBHOOK_URL;

  if (url === undefined || url === '') return null;

  const secret = env.HIVEMIND_WEBHOOK_SECRET;

  if (secret === undefined || secret === '') {
    throw new HivemindError('unavailable', 'HIVEMIND_WEBHOOK_SECRET is not set.');
  }

  if (!URL.canParse(url)) {
    throw new HivemindError('unavailable', 'HIVEMIND_WEBHOOK_URL is not a valid address.');
  }

  try {
    checkWebhookTarget(new URL(url));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The webhook address is not valid.';

    throw new HivemindError(
      'unavailable',
      reason.replace('The webhook address', 'HIVEMIND_WEBHOOK_URL')
    );
  }

  refuseHttpThroughProxy(new URL(url), env);

  return createWebhookNotifier({ url, secret });
}

/**
 * Bun sends an http request through {@code HTTP_PROXY}, in the clear, even to a loopback host. It
 * matches {@code NO_PROXY} against the address in the request as it is written in the URL, so
 * only {@code *} or that exact address, bracketed for IPv6, keeps the request direct. That address
 * is the one the request uses, so {@code localhost} counts as 127.0.0.1. https goes through its own
 * tunnel and is not refused.
 *
 * <p>Bun reads the lowercase variable of each pair first, and a lowercase variable that is empty
 * still wins over an uppercase one that is set.
 */
function refuseHttpThroughProxy(target: URL, env: Record<string, string | undefined>): void {
  if (target.protocol !== 'http:') return;

  const proxy = lowercaseFirst(env, 'http_proxy');

  if (proxy === undefined || proxy === '') return;

  const exempt = (lowercaseFirst(env, 'no_proxy') ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase());
  const address = httpRequestAddress(target);
  const requestHost = (address.includes(':') ? `[${address}]` : address).toLowerCase();

  if (exempt.includes('*') || exempt.includes(requestHost)) return;

  throw new HivemindError(
    'unavailable',
    'HIVEMIND_WEBHOOK_URL cannot be an http address while HTTP_PROXY is set, because the request would go through the proxy unencrypted. Use https, or add the host to NO_PROXY.'
  );
}

function lowercaseFirst(env: Record<string, string | undefined>, lowercaseName: string) {
  return env[lowercaseName] ?? env[lowercaseName.toUpperCase()];
}

/**
 * A resolver error can carry the host name, as Node's `getaddrinfo ENOTFOUND <host>` does, and a
 * Slack workflow address is a secret, so only the error code of a failed lookup is kept.
 */
function lookupFailingWithCodeOnly(
  lookUp: (host: string) => Promise<string[]>
): (host: string) => Promise<string[]> {
  return async host => {
    try {
      return await lookUp(host);
    } catch (error) {
      throw new Error(`The webhook name could not be resolved (${codeOf(error)}).`);
    }
  };
}

async function send(
  options: WebhookOptions,
  resolve: (host: string) => Promise<string[]>,
  notification: Notification,
  signal: AbortSignal
): Promise<void> {
  const target = new URL(options.url);
  const addresses = await (options.checkAddresses ?? (url => checkedAddresses(url, resolve)))(
    target
  );
  const body = JSON.stringify(bodyOf(notification));
  const headers = {
    host: target.protocol === 'https:' ? target.hostname : target.host,
    'content-type': 'application/json',
    'hivemind-timestamp': notification.sentAt,
    'hivemind-signature': `v1=${webhookSignature(options.secret, notification.sentAt, body)}`,
    'hivemind-delivery': notification.deliveryId,
  };
  const status = await postToFirstAddress(options, target, addresses, headers, body, signal);

  if (status >= 300 && status < 400) throw new Error('The webhook refused to follow a redirect.');
  if (status < 200 || status > 299) {
    throw new Error(`The webhook did not accept the notification (HTTP ${status}).`);
  }
}

/** Try each address in turn. Only a connection that fails moves on: an answer, even an error, ends it. */
async function postToFirstAddress(
  options: WebhookOptions,
  target: URL,
  addresses: string[],
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal
): Promise<number> {
  const fetchOnce = options.fetch ?? fetch;
  let failure = new Error('The webhook request failed (no address).');

  for (const address of addresses) {
    const requestUrl = new URL(target.toString());

    requestUrl.hostname = address.includes(':') ? `[${address}]` : address;

    try {
      const response = await fetchOnce(requestUrl.toString(), {
        method: 'POST',
        redirect: 'manual',
        keepalive: false,
        headers,
        body,
        signal,
        ...tlsFor(target, options.trustedCertificate),
      });

      response.body?.cancel().catch(() => undefined);

      return response.status;
    } catch (error) {
      failure = new Error(`The webhook request failed (${codeOf(error)}).`);
    }
  }

  throw failure;
}

function tlsFor(target: URL, trustedCertificate: string | undefined): RequestInitWithTls {
  if (target.protocol !== 'https:') return {};

  const host = target.hostname.replace(/^\[|\]$/g, '');

  return {
    tls: {
      ...(isIP(host) === 0 ? { serverName: host } : {}),
      ...(trustedCertificate === undefined ? {} : { ca: trustedCertificate }),
    },
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : 'unknown';
  const candidate = typeof code === 'string' ? code : name;

  return /^[A-Za-z0-9_]{1,64}$/.test(candidate) ? candidate : 'unknown';
}

async function withinTime<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The webhook did not answer in time.'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function bodyOf(notification: Notification): Record<string, string> {
  return {
    delivery_id: notification.deliveryId,
    sent_at: notification.sentAt,
    reminder: notification.reminder ? 'true' : 'false',
    workspace_id: notification.workspaceId,
    group_id: notification.groupId ?? '',
    group_name: notification.groupName ?? '',
    alert_id: notification.alertId,
    target_id: notification.targetId,
    rule: notification.rule,
    severity: notification.severity,
    summary: notification.summary,
    action: notification.action,
    task_title: notification.taskTitle ?? '',
    session_role: notification.sessionRole ?? '',
    session_address: notification.sessionAddress ?? '',
    open_for: notification.openFor,
    reason: notification.reason ?? '',
  };
}

async function defaultLookup(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true, verbatim: true });

  return rows.map(row => row.address);
}
