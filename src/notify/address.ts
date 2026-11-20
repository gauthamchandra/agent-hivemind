const refusedIpv4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

/**
 * Refuse a webhook address that can never be safe, without a name lookup. A service that has
 * this check at startup stops there, not on the first delivery. http is accepted only for a
 * loopback host, and a name or an address that is not public is refused. The messages never
 * repeat the address, because a Slack workflow address is a secret.
 */
export function checkWebhookTarget(target: URL): void {
  const host = hostOf(target);

  if (target.protocol === 'http:' && isLoopback(host)) return;
  if (target.protocol !== 'https:') throw new Error('The webhook address must use https.');
  if (isBlockedName(host) || isBlockedAddress(host)) {
    throw new Error('The webhook address is not a public network.');
  }
}

/**
 * Pick the addresses a webhook request may connect to, IPv4 first, or refuse the target.
 *
 * <p>A name is resolved once, and every address in its answer must be a public address that
 * parses strictly, because a name may answer with a private address next to a public one, and a
 * form such as a zone id or a short number must not be left for the connection to interpret.
 */
export async function checkedAddresses(
  target: URL,
  resolve: (host: string) => Promise<string[]>
): Promise<string[]> {
  checkWebhookTarget(target);

  const host = hostOf(target);

  if (target.protocol === 'http:') return [httpRequestAddress(target)];
  if (addressBytes(host) !== null) return [host];

  const answer = await resolve(host);

  if (answer.length === 0 || !answer.every(isPublicAddress)) {
    throw new Error('The webhook address is not a public network.');
  }

  return [...answer.filter(isIpv4), ...answer.filter(address => !isIpv4(address))];
}

/** True for an address that is not on the public internet. A name is not an address, so it is false. */
export function isBlockedAddress(host: string): boolean {
  const bytes = addressBytes(host);

  if (bytes === null) return false;

  return bytes.length === 4 ? blockedIpv4(bytes) : blockedIpv6(bytes);
}

/** True only for a string that parses strictly as an address and is on the public internet. */
export function isPublicAddress(host: string): boolean {
  const bytes = addressBytes(host);

  if (bytes === null) return false;

  return !(bytes.length === 4 ? blockedIpv4(bytes) : blockedIpv6(bytes));
}

/** The address an http webhook request connects to: `localhost` is requested as 127.0.0.1. */
export function httpRequestAddress(target: URL): string {
  const host = hostOf(target);

  return host === 'localhost' ? '127.0.0.1' : host;
}

function hostOf(target: URL): string {
  return target.hostname.replace(/^\[|\]$/g, '');
}

function isIpv4(address: string): boolean {
  return ipv4Bytes(address) !== null;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isBlockedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');

  return name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal';
}

function addressBytes(host: string): Uint8Array | null {
  return ipv4Bytes(host) ?? ipv6Bytes(host);
}

function ipv4Bytes(host: string): Uint8Array | null {
  const parts = host.split('.');

  if (parts.length !== 4) return null;

  const numbers = parts.map(part => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : Number.NaN));

  if (numbers.some(part => !Number.isInteger(part) || part > 255)) return null;

  return Uint8Array.from(numbers);
}

function ipv6Bytes(host: string): Uint8Array | null {
  const dotted = host.toLowerCase().match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let text = host.toLowerCase();

  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    const tail = ipv4Bytes(dotted[2]);

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

  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<number>(zeroCount).fill(0), ...right];
  const bytes = new Uint8Array(16);

  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });

  return bytes;
}

function hextets(text: string): number[] | null {
  if (text === '') return [];

  const parts = text.split(':');

  if (parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  return parts.map(part => Number.parseInt(part, 16));
}

function blockedIpv4(bytes: Uint8Array): boolean {
  const address = unsigned(bytes);

  return refusedIpv4.some(([network, bits]) => {
    const shift = 32 - bits;

    return address >>> shift === unsigned(ipv4Bytes(network) ?? new Uint8Array(4)) >>> shift;
  });
}

function unsigned(bytes: Uint8Array): number {
  return (
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0
  );
}

/**
 * An address that embeds an IPv4 address reaches that IPv4 host, so it is as private as the
 * embedded address: the IPv4-mapped, IPv4-compatible and NAT64 forms.
 */
function blockedIpv6(bytes: Uint8Array): boolean {
  const embedded = bytes.subarray(12, 16);

  if (zeros(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return blockedIpv4(embedded);
  if (zeros(bytes, 0, 12)) return blockedIpv4(embedded);
  if (isTranslated(bytes) || isNat64(bytes)) return blockedIpv4(embedded);
  if (isTeredo(bytes)) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedIpv4(bytes.subarray(2, 6));

  return !isGlobalUnicast(bytes) || isDocumentation(bytes);
}

/** `2000::/3` is the only part of the IPv6 space that is handed out for use on the internet. */
function isGlobalUnicast(bytes: Uint8Array): boolean {
  return ((bytes[0] ?? 0) & 0xe0) === 0x20;
}

/** `2001:db8::/32` and `3fff::/20` are reserved for documentation. */
function isDocumentation(bytes: Uint8Array): boolean {
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;

  return (
    (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) ||
    (first === 0x3f && second === 0xff && (third & 0xf0) === 0)
  );
}

/** `::ffff:0:a.b.c.d`, the IPv4-translated form. */
function isTranslated(bytes: Uint8Array): boolean {
  return zeros(bytes, 0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(bytes, 10, 12);
}

/** `2001::/32` tunnels IPv4 through a relay the service does not choose. */
function isTeredo(bytes: Uint8Array): boolean {
  return bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00;
}

function isNat64(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    zeros(bytes, 4, 12)
  );
}

function zeros(bytes: Uint8Array, from: number, until: number): boolean {
  return bytes.slice(from, until).every(byte => byte === 0);
}
