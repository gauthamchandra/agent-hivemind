import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 32 random bytes, marked so a secret scanner can recognize an operator key. */
export function operatorKeySecret(random: { bytes(length: number): Uint8Array }): string {
  return `opk_${Buffer.from(random.bytes(32)).toString('base64url')}`;
}

/** 32 random bytes, marked so a secret scanner can recognize a session token. */
export function sessionTokenSecret(random: { bytes(length: number): Uint8Array }): string {
  return `ses_${Buffer.from(random.bytes(32)).toString('base64url')}`;
}

/** 32 random bytes, marked so a secret scanner can recognize an enrollment code. */
export function enrollmentCodeSecret(random: { bytes(length: number): Uint8Array }): string {
  return `enr_${Buffer.from(random.bytes(32)).toString('base64url')}`;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Seal a value with the configured response key. The result is not the value
 * and cannot be opened without that key.
 */
export async function sealText(
  secret: string,
  plaintext: string,
  random: { bytes(length: number): Uint8Array }
): Promise<string> {
  const nonce = random.bytes(12);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: copyBytes(nonce) },
      await responseKey(secret),
      copyBytes(textEncoder.encode(plaintext))
    )
  );

  return `v1.${Buffer.from(nonce).toString('base64url')}.${Buffer.from(cipher).toString('base64url')}`;
}

/** Open a value sealed with the same configured response key. */
export async function openText(secret: string, sealed: string): Promise<string | null> {
  const [version, nonce, cipher] = sealed.split('.');

  if (version !== 'v1' || nonce === undefined || cipher === undefined) return null;

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: copyBytes(Buffer.from(nonce, 'base64url')) },
      await responseKey(secret),
      copyBytes(Buffer.from(cipher, 'base64url'))
    );

    return textDecoder.decode(plain);
  } catch {
    return null;
  }
}

function copyBytes(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);

  new Uint8Array(copy).set(value);

  return copy;
}

async function responseKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));

  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
