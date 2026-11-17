import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 32 random bytes, marked so a secret scanner can recognize an operator key. */
export function operatorKeySecret(random: { bytes(length: number): Uint8Array }): string {
  return `opk_${Buffer.from(random.bytes(32)).toString('base64url')}`;
}
